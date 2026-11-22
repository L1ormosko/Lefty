import type { AssignmentKind, OrganizationalAssignment, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx, openEndedWhere } from "@/server/authz";
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  ValidationError,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { endInstant } from "./active-window";
import { lockUnitShared } from "./employees";
import type { AssignEmployeeInput, EndAssignmentInput } from "./schemas";

/**
 * Organizational placement over time (§3.4). A placement row is NEVER overwritten: a transfer
 * closes the current PRIMARY row (`effectiveTo`) and inserts a new one, so "where was this person
 * on 3 March?" is always answerable (`orgUnitAtUnchecked`). The database additionally forbids two PRIMARY
 * placements of one employee overlapping in time (exclusion constraint).
 *
 *  - PRIMARY: the operational team; exactly one at any instant.
 *  - SECONDARY: an extra, open-ended placement (works for two teams).
 *  - TEMPORARY: an extra placement with a mandatory end (covering another branch for two weeks).
 *
 * Placement is separate from the legal employer (`Employee.legalEntityId`).
 */

/** A placement as returned by the API, with the change it represents. */
export interface AssignmentView {
  id: string;
  employeeId: string;
  orgUnitId: string;
  kind: AssignmentKind;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string | null;
  /** Who recorded the change. */
  createdById: string | null;
  createdAt: Date;
  /** For a PRIMARY row: the unit the employee was in right before (null for the first placement). */
  previousOrgUnitId: string | null;
}

/** Clock-skew tolerance: a change dated within this window of "now" is a normal change, not a correction. */
const CORRECTION_TOLERANCE_MS = 5 * 60_000;

/**
 * Changing the past is a CORRECTION of recorded history, not a normal change: it is allowed only
 * with a written reason and is audited as `correction: true`, so nobody can quietly re-date where
 * someone worked. Returns whether this change is one.
 * @throws ValidationError (field `reason`) when a past date comes without a reason.
 */
function requireReasonForCorrection(date: Date, now: Date, reason: string | undefined, field: string): boolean {
  if (date.getTime() >= now.getTime() - CORRECTION_TOLERANCE_MS) return false;
  if (!reason) {
    throw new ValidationError({ message: `A change dated in the past (${field}) is a correction and needs a reason.`, field: "reason" });
  }
  return true;
}

const toView = (row: OrganizationalAssignment, previousOrgUnitId: string | null): AssignmentView => ({
  id: row.id,
  employeeId: row.employeeId,
  orgUnitId: row.orgUnitId,
  kind: row.kind,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  reason: row.reason,
  createdById: row.createdById,
  createdAt: row.createdAt,
  previousOrgUnitId,
});

/** Existing rows whose period overlaps [from, to); `to` null = open-ended. */
const overlapsWindow = (from: Date, to: Date | null): Prisma.OrganizationalAssignmentWhereInput => ({
  ...(to ? { effectiveFrom: { lt: to } } : {}),
  ...openEndedWhere(from),
});

/** Closes the open PRIMARY row at `from` when this is a transfer; returns the unit being left. */
async function closeCurrentPrimary(
  tx: TenantTx,
  tenantId: string,
  employeeId: string,
  from: Date,
  newOrgUnitId: string,
): Promise<{ closedId: string | null; previousOrgUnitId: string | null }> {
  const latest = await tx.organizationalAssignment.findFirst({
    where: { tenantId, employeeId, kind: "PRIMARY" },
    orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
  });
  if (!latest) return { closedId: null, previousOrgUnitId: null };

  if (from <= latest.effectiveFrom) {
    throw new ValidationError({
      message: "The new placement must start after the current one started; history is never rewritten.",
      field: "effectiveFrom",
    });
  }
  if (latest.effectiveTo !== null && latest.effectiveTo > from) {
    throw new ConflictError({ message: "The current placement already has a later end date.", field: "effectiveFrom" });
  }
  if (latest.effectiveTo === null && latest.orgUnitId === newOrgUnitId) {
    throw new ValidationError({ message: "The employee is already placed in this unit.", field: "orgUnitId" });
  }
  if (latest.effectiveTo !== null) return { closedId: null, previousOrgUnitId: latest.orgUnitId };
  await tx.organizationalAssignment.update({ where: { id: latest.id }, data: { effectiveTo: from } });
  return { closedId: latest.id, previousOrgUnitId: latest.orgUnitId };
}

/**
 * Places an employee in an org unit. Needs `employees.assign` over the EMPLOYEE (where they are
 * now) AND over the DESTINATION unit, so a manager can neither pull people out of a unit they do not
 * control nor push people into one they do not control. The unit must be active, the employee not
 * terminated. Serialised per employee so two concurrent transfers cannot interleave.
 *
 * @throws ValidationError (dates), ConflictError (overlapping placement), InvalidStateTransitionError.
 */
export async function assignEmployeeToUnit(
  actor: Actor,
  ctx: RequestContext,
  employeeId: string,
  input: AssignEmployeeInput,
): Promise<AssignmentView> {
  return withTenant(actor.tenantId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`employee-assignment:${employeeId}`}))`;
    await enforceInTx(tx, actor, "employees.assign", { employeeId });
    await enforceInTx(tx, actor, "employees.assign", { orgUnitId: input.orgUnitId });

    const employee = await tx.employee.findFirst({ where: { id: employeeId, tenantId: actor.tenantId }, select: { status: true } });
    if (!employee) throw new NotFoundError();
    if (employee.status === "TERMINATED") throw new InvalidStateTransitionError({ message: "A terminated employee cannot be placed." });
    const unit = await lockUnitShared(tx, actor.tenantId, input.orgUnitId);
    if (!unit) throw new NotFoundError();
    if (!unit.active) throw new InvalidStateTransitionError({ message: "Employees cannot be placed in an archived unit." });

    const from = input.effectiveFrom ?? new Date();
    const to = input.effectiveTo ?? null;
    const correction = requireReasonForCorrection(from, new Date(), input.reason, "effectiveFrom");
    if (to !== null && to <= from) {
      throw new ValidationError({ message: "effectiveTo must be after effectiveFrom.", field: "effectiveTo" });
    }

    let closedId: string | null = null;
    let previousOrgUnitId: string | null = null;
    if (input.kind === "PRIMARY") {
      ({ closedId, previousOrgUnitId } = await closeCurrentPrimary(tx, actor.tenantId, employeeId, from, input.orgUnitId));
    } else {
      const duplicate = await tx.organizationalAssignment.findFirst({
        where: { tenantId: actor.tenantId, employeeId, orgUnitId: input.orgUnitId, ...overlapsWindow(from, to) },
        select: { id: true },
      });
      if (duplicate) throw new ConflictError({ message: "The employee already has a placement in this unit for that period." });
    }

    const created = await tx.organizationalAssignment.create({
      data: {
        tenantId: actor.tenantId,
        employeeId,
        orgUnitId: input.orgUnitId,
        kind: input.kind,
        effectiveFrom: from,
        effectiveTo: to,
        reason: input.reason,
        createdById: actor.userId,
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "employee.assign",
      targetType: "Employee",
      targetId: employeeId,
      previousValue: previousOrgUnitId ? { orgUnitId: previousOrgUnitId, closedAssignmentId: closedId } : undefined,
      newValue: {
        assignmentId: created.id,
        orgUnitId: input.orgUnitId,
        kind: input.kind,
        effectiveFrom: from.toISOString(),
        effectiveTo: to?.toISOString() ?? null,
        ...(correction ? { correction: true } : {}),
      },
      reason: input.reason,
    });
    return toView(created, previousOrgUnitId);
  });
}

/**
 * Ends a SECONDARY or TEMPORARY placement (default: now; a TEMPORARY one may only be shortened).
 * A PRIMARY placement cannot just end (the employee would be nowhere): transfer or terminate instead.
 * Needs `employees.assign` over the employee.
 */
export async function endEmployeeAssignment(
  actor: Actor,
  ctx: RequestContext,
  employeeId: string,
  assignmentId: string,
  input: EndAssignmentInput,
): Promise<AssignmentView> {
  return withTenant(actor.tenantId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`employee-assignment:${employeeId}`}))`;
    await enforceInTx(tx, actor, "employees.assign", { employeeId });
    const row = await tx.organizationalAssignment.findFirst({ where: { id: assignmentId, tenantId: actor.tenantId, employeeId } });
    if (!row) throw new NotFoundError();
    if (row.kind === "PRIMARY") {
      throw new InvalidStateTransitionError({ message: "A primary placement cannot be ended; transfer the employee or terminate them." });
    }

    const now = new Date();
    if (row.effectiveTo !== null && row.effectiveTo <= now) {
      throw new InvalidStateTransitionError({ message: "This placement has already ended." });
    }
    const wanted = input.effectiveTo ?? now;
    const correction = requireReasonForCorrection(wanted, now, input.reason, "effectiveTo");
    if (row.effectiveTo !== null && wanted > row.effectiveTo) {
      throw new ValidationError({ message: "A placement can only be shortened, not extended.", field: "effectiveTo" });
    }
    const updated = await tx.organizationalAssignment.update({
      where: { id: row.id },
      data: { effectiveTo: endInstant(row.effectiveFrom, wanted) },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "employee.assignment_end",
      targetType: "Employee",
      targetId: employeeId,
      previousValue: { assignmentId: row.id, effectiveTo: row.effectiveTo?.toISOString() ?? null },
      newValue: { assignmentId: row.id, effectiveTo: updated.effectiveTo?.toISOString() ?? null, ...(correction ? { correction: true } : {}) },
      reason: input.reason,
    });
    return toView(updated, null);
  });
}

/**
 * Placement history of one employee, newest first (previous unit / new unit / effective date / who /
 * why). Needs `employees.view` over the employee with the `base` field set. Read-only; rows are
 * never edited, so this is the audit-grade record reports rely on.
 */
export async function listEmployeeAssignments(
  actor: Actor,
  employeeId: string,
  query: { cursor?: string; limit: number },
): Promise<Page<AssignmentView>> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "employees.view", { employeeId });
    if (!decision.fieldSets.includes("base")) throw new ForbiddenError();

    const rows = await tx.organizationalAssignment.findMany({
      where: { tenantId: actor.tenantId, employeeId },
      orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);

    // "Previous unit" = the PRIMARY row that came right before, which may be on the next page.
    const primaryHistory = await tx.organizationalAssignment.findMany({
      where: { tenantId: actor.tenantId, employeeId, kind: "PRIMARY" },
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
      select: { id: true, orgUnitId: true },
    });
    const previousOf = new Map<string, string | null>();
    primaryHistory.forEach((row, index) => previousOf.set(row.id, index === 0 ? null : primaryHistory[index - 1].orgUnitId));
    return { data: page.data.map((row) => toView(row, previousOf.get(row.id) ?? null)), page: page.page };
  });
}
