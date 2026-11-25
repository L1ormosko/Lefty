import type { Prisma, ReconciliationExceptionStatus } from "@prisma/client";
import { canTransitionException } from "@/lib/reconciliation-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { canInTx } from "@/server/authz";
import { InvalidStateTransitionError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { exceptionRef } from "./access";
import { exceptionViewsInTx, loadExceptionInTx } from "./read";
import type { AssignExceptionInput, ResolveExceptionInput, UnassignExceptionInput } from "./schemas";
import type { ExceptionView } from "./views";

/**
 * The exception workflow (spec 5.7): OPEN <-> ASSIGNED -> RESOLVED, the machine in `src/lib/reconciliation-rules.ts` and
 * the database trigger `reconciliation_exception_status`.
 * - assign / reassign / unassign: `finance_reconciliation.assign` over the exception; the assignee must be able to
 *   resolve it (`finance_reconciliation.edit` over it), so work is never parked with someone who cannot act;
 * - resolve: `finance_reconciliation.edit` over the exception, always with a reason; the resolver is the caller.
 * Resolving changes no money: the person fixes the cause through payments, reversals or adjustments and records why
 * the exception is closed. What was found (kind, references, amounts) is frozen by the database.
 *
 * Concurrency: every update is conditional on the status that was read, so two people acting at once change the record
 * once; the loser gets `409 reconciliation.exception_changed` (or a replay when they asked for the same result).
 */

type Change = { replayed: boolean; exception: ExceptionView };

function invalid(from: ReconciliationExceptionStatus, to: ReconciliationExceptionStatus): InvalidStateTransitionError {
  const message = `A ${from} exception cannot become ${to}.`;
  return new InvalidStateTransitionError({ message, details: [{ field: "status", code: "reconciliation.invalid_transition", message }] });
}

function changedMeanwhile(): InvalidStateTransitionError {
  const message = "The exception was changed by someone else; reload it.";
  return new InvalidStateTransitionError({ message, details: [{ field: "status", code: "reconciliation.exception_changed", message }] });
}

async function viewOf(tx: TenantTx, actor: Actor, exceptionId: string, permission: string): Promise<ExceptionView> {
  const [view] = await exceptionViewsInTx(tx, actor, [await loadExceptionInTx(tx, actor, exceptionId, permission)]);
  return view;
}

/** Conditional update: true when the row still had `expected` status (and assignee) and was changed. */
async function update(
  tx: TenantTx,
  tenantId: string,
  exceptionId: string,
  expected: { status: ReconciliationExceptionStatus; assignedToId: string | null },
  data: Prisma.ReconciliationExceptionUncheckedUpdateManyInput,
): Promise<boolean> {
  const { count } = await tx.reconciliationException.updateMany({
    where: { id: exceptionId, tenantId, status: expected.status, assignedToId: expected.assignedToId },
    data,
  });
  return count === 1;
}

/** Gives the exception to a person (OPEN -> ASSIGNED, or ASSIGNED to someone else). */
export async function assignReconciliationException(actor: Actor, ctx: RequestContext, exceptionId: string, input: AssignExceptionInput): Promise<Change> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await loadExceptionInTx(tx, actor, exceptionId, "finance_reconciliation.assign");
    if (row.status === "ASSIGNED" && row.assignedToId === input.assignedToId) {
      return { replayed: true, exception: await viewOf(tx, actor, exceptionId, "finance_reconciliation.assign") };
    }
    if (row.status !== "ASSIGNED" && !canTransitionException(row.status, "ASSIGNED")) throw invalid(row.status, "ASSIGNED");

    // The assignee is checked against the record itself (under RLS: a user of another tenant does not exist here).
    const assignee = await canInTx(tx, { tenantId: actor.tenantId, userId: input.assignedToId }, "finance_reconciliation.edit", exceptionRef(row));
    if (!assignee.allowed) {
      const message = "This person cannot resolve this exception.";
      throw new ValidationError({ message, field: "body.assignedToId", details: [{ field: "body.assignedToId", code: "reconciliation.assignee_not_eligible", message }] });
    }
    const now = new Date();
    if (!(await update(tx, actor.tenantId, row.id, row, { status: "ASSIGNED", assignedToId: input.assignedToId, assignedAt: now }))) throw changedMeanwhile();
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "reconciliation_exception.assign",
      targetType: "ReconciliationException",
      targetId: row.id,
      previousValue: { status: row.status, assignedToId: row.assignedToId },
      newValue: { status: "ASSIGNED", assignedToId: input.assignedToId },
      reason: input.note,
    });
    return { replayed: false, exception: await viewOf(tx, actor, exceptionId, "finance_reconciliation.assign") };
  });
}

/** Puts an assigned exception back in the open queue (ASSIGNED -> OPEN). */
export async function unassignReconciliationException(actor: Actor, ctx: RequestContext, exceptionId: string, input: UnassignExceptionInput): Promise<Change> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await loadExceptionInTx(tx, actor, exceptionId, "finance_reconciliation.assign");
    if (row.status === "OPEN") return { replayed: true, exception: await viewOf(tx, actor, exceptionId, "finance_reconciliation.assign") };
    if (!canTransitionException(row.status, "OPEN")) throw invalid(row.status, "OPEN");
    if (!(await update(tx, actor.tenantId, row.id, row, { status: "OPEN", assignedToId: null, assignedAt: null }))) throw changedMeanwhile();
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "reconciliation_exception.unassign",
      targetType: "ReconciliationException",
      targetId: row.id,
      previousValue: { status: row.status, assignedToId: row.assignedToId },
      newValue: { status: "OPEN", assignedToId: null },
      reason: input.reason,
    });
    return { replayed: false, exception: await viewOf(tx, actor, exceptionId, "finance_reconciliation.assign") };
  });
}

/** Closes the exception with the caller as resolver and a reason (OPEN | ASSIGNED -> RESOLVED, final). */
export async function resolveReconciliationException(actor: Actor, ctx: RequestContext, exceptionId: string, input: ResolveExceptionInput): Promise<Change> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await loadExceptionInTx(tx, actor, exceptionId, "finance_reconciliation.edit");
    if (row.status === "RESOLVED") {
      if (row.resolvedById === actor.userId && row.resolutionReason === input.reason) {
        return { replayed: true, exception: await viewOf(tx, actor, exceptionId, "finance_reconciliation.edit") };
      }
      throw invalid(row.status, "RESOLVED");
    }
    if (!(await update(tx, actor.tenantId, row.id, row, { status: "RESOLVED", resolvedAt: new Date(), resolvedById: actor.userId, resolutionReason: input.reason }))) {
      throw changedMeanwhile();
    }
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "reconciliation_exception.resolve",
      targetType: "ReconciliationException",
      targetId: row.id,
      previousValue: { status: row.status, assignedToId: row.assignedToId },
      newValue: { status: "RESOLVED", resolvedById: actor.userId },
      reason: input.reason,
    });
    return { replayed: false, exception: await viewOf(tx, actor, exceptionId, "finance_reconciliation.edit") };
  });
}
