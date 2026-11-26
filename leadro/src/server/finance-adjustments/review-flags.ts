import type { FinanceReviewFlag, FinanceReviewFlagStatus, Prisma } from "@prisma/client";
import { REVIEW_FLAG_REASONS } from "@/lib/finance-correction-rules";
import { serializeJson } from "@/lib/money";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, canInTx, enforceInTx, resolveScope, withinScope, type ResourceRef, type ScopeColumns } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { auditFields, manualRecordKey, requireClientKey, requireFinanceJob } from "./common";
import type { AssignFlagInput, ListFlagsQuery, RaiseFlagInput, ResolveFlagInput } from "./schemas";

/**
 * Finance review flags (`FinanceReviewFlag`, spec 11.7 "Flag for finance review", 25.4). A flag says "a person in finance
 * must look at this": a job reopened after money was posted, an outcome corrected after its charge was posted, a refund
 * paid out or a chargeback opened (whatever compensation counted that money needs a human decision: nothing is deducted
 * or reversed automatically, spec 11.7), a material cost that could not be posted, or a person's own concern.
 *
 * Raising is IDEMPOTENT per triggering event: every machine flag carries a deterministic key (`reviewFlagKeys`), the insert
 * is `ON CONFLICT DO NOTHING`, so a retried or concurrent trigger raises one flag. What was flagged, why and by whom is
 * frozen (DB trigger); only assignment and resolution move: OPEN <-> ASSIGNED -> RESOLVED (resolution needs a reason).
 *
 * Permissions (docs/PERMISSIONS.md section 11, no keys of their own): read `finance_reconciliation.view`, raise by hand
 * `finance_reconciliation.create`, assign / unassign `finance_reconciliation.assign`, resolve `finance_reconciliation.edit`.
 * Scope is the flag's `orgUnitId` (the job's unit when raised); a flag without a unit is tenant-level (TENANT scope only).
 */

const READ = "finance_reconciliation.view";

/** The references a flag can carry (at least one: DB CHECK `finance_review_flag_subject`). */
export interface FlagRefs {
  jobId?: string | null;
  customerId?: string | null;
  outcomeId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  chargebackId?: string | null;
  adjustmentId?: string | null;
  ledgerEntryId?: string | null;
}

export interface RaiseFlagInTxInput {
  tenantId: string;
  /** Lowercase dotted machine code (`REVIEW_FLAG_REASONS`). */
  reasonCode: string;
  /** Deterministic per triggering event. */
  idempotencyKey: string;
  refs: FlagRefs;
  /** The job's unit (scope); null = tenant-level. */
  orgUnitId: string | null;
  /** Ids, codes and amounts (bigint becomes a decimal string); never free text. */
  details?: Record<string, unknown>;
  /** A person (with an optional note) or a machine actor (`system:<name>`, never a note: DB CHECK). */
  raisedBy: { userId: string; note?: string } | { system: string };
  ctx: RequestContext | null;
}

/** What a flag looks like in API responses: everything but the tenant and the internal key. */
export type FlagView = Omit<FinanceReviewFlag, "tenantId" | "idempotencyKey">;
export function toFlagView(flag: FinanceReviewFlag): FlagView {
  const { tenantId: _tenantId, idempotencyKey: _key, ...view } = flag;
  return view;
}

/**
 * Raises a flag unless one exists under `idempotencyKey`, INSIDE the caller's transaction (a flag is a side effect of a
 * money or job change and commits with it). No permission check: the calling service already authorized its own change.
 * Audits `finance_review_flag.raise` only when a flag was created.
 */
export async function raiseFinanceReviewFlagInTx(tx: TenantTx, input: RaiseFlagInTxInput): Promise<{ flag: FinanceReviewFlag; created: boolean }> {
  const person = "userId" in input.raisedBy ? input.raisedBy : null;
  const data: Prisma.FinanceReviewFlagCreateManyInput = {
    tenantId: input.tenantId,
    reasonCode: input.reasonCode,
    note: person?.note ?? null,
    details: input.details ? (serializeJson(input.details) as Prisma.InputJsonObject) : undefined,
    jobId: input.refs.jobId ?? null,
    customerId: input.refs.customerId ?? null,
    outcomeId: input.refs.outcomeId ?? null,
    paymentId: input.refs.paymentId ?? null,
    refundId: input.refs.refundId ?? null,
    chargebackId: input.refs.chargebackId ?? null,
    adjustmentId: input.refs.adjustmentId ?? null,
    ledgerEntryId: input.refs.ledgerEntryId ?? null,
    orgUnitId: input.orgUnitId,
    idempotencyKey: input.idempotencyKey,
    raisedById: person?.userId ?? null,
    systemActor: "system" in input.raisedBy ? input.raisedBy.system : null,
  };
  const inserted = await tx.financeReviewFlag.createMany({ data: [data], skipDuplicates: true });
  const flag = await tx.financeReviewFlag.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } } });
  const created = inserted.count === 1;
  if (created) {
    await recordAudit(tx, {
      ...auditFields(input.tenantId, input.ctx),
      action: "finance_review_flag.raise",
      targetType: "FinanceReviewFlag",
      targetId: flag.id,
      newValue: { status: flag.status, reasonCode: flag.reasonCode, jobId: flag.jobId, orgUnitId: flag.orgUnitId, systemActor: flag.systemActor },
    });
  }
  return { flag, created };
}

/** The authorization reference of a flag: its unit, or tenant-level when it has none. */
const flagRef = (flag: Pick<FinanceReviewFlag, "orgUnitId">): ResourceRef => (flag.orgUnitId ? { orgUnitId: flag.orgUnitId } : {});

/** Route resolver: a flag's reference, or null when it does not exist. */
export async function reviewFlagResourceRef(tx: TenantTx, tenantId: string, flagId: string): Promise<ResourceRef | null> {
  const flag = await tx.financeReviewFlag.findFirst({ where: { id: flagId, tenantId }, select: { orgUnitId: true } });
  return flag ? flagRef(flag) : null;
}

const flagScopeColumns: ScopeColumns<Prisma.FinanceReviewFlagWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
};

/** Loads (and row-locks) a flag the actor may act on with `permission` (404 outside scope). */
async function loadFlagFor(tx: TenantTx, actor: Actor, flagId: string, permission: string): Promise<FinanceReviewFlag> {
  await enforceInTx(tx, actor, permission);
  await tx.$queryRaw`SELECT "id" FROM "FinanceReviewFlag" WHERE "id" = ${flagId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
  const flag = await tx.financeReviewFlag.findFirst({ where: { id: flagId, tenantId: actor.tenantId } });
  if (!flag) throw new NotFoundError();
  // Seeing the flag is the precondition of acting on it (no existence leak outside the reader's scope).
  await enforceInTx(tx, actor, READ, flagRef(flag));
  await enforceInTx(tx, actor, permission, flagRef(flag));
  return flag;
}

function invalidTransition(flag: FinanceReviewFlag, target: FinanceReviewFlagStatus): InvalidStateTransitionError {
  const message = `A ${flag.status} review flag cannot become ${target}.`;
  return new InvalidStateTransitionError({ message, details: [{ field: "status", code: "review_flag.invalid_transition", message }] });
}

async function auditChange(tx: TenantTx, ctx: RequestContext, action: string, before: FinanceReviewFlag, after: FinanceReviewFlag, reason?: string): Promise<void> {
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action,
    targetType: "FinanceReviewFlag",
    targetId: after.id,
    previousValue: { status: before.status, assignedToId: before.assignedToId },
    newValue: { status: after.status, assignedToId: after.assignedToId },
    reason,
  });
}

/**
 * `POST /finance/review-flags`: a person flags a job (and optionally one of its money records) for finance review.
 * `finance_reconciliation.create` over the job; the `Idempotency-Key` is required and becomes the flag's key.
 */
export async function raiseManualFlag(actor: Actor, ctx: RequestContext, input: RaiseFlagInput, clientKey: string | null): Promise<{ flag: FlagView; replayed: boolean }> {
  const key = manualRecordKey(actor.userId, requireClientKey(clientKey, "review_flag.idempotency_key_required"));
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_reconciliation.create");
    const job = await requireFinanceJob(tx, actor.tenantId, input.jobId);
    await enforceInTx(tx, actor, "finance_reconciliation.create", { orgUnitId: job.orgUnitId });
    await assertRefsBelongToJob(tx, actor.tenantId, job.id, input);
    const { flag, created } = await raiseFinanceReviewFlagInTx(tx, {
      tenantId: actor.tenantId,
      reasonCode: REVIEW_FLAG_REASONS.manual,
      idempotencyKey: key,
      refs: {
        jobId: job.id,
        customerId: job.customerId,
        paymentId: input.paymentId,
        refundId: input.refundId,
        chargebackId: input.chargebackId,
        adjustmentId: input.adjustmentId,
        ledgerEntryId: input.ledgerEntryId,
      },
      orgUnitId: job.orgUnitId,
      raisedBy: { userId: actor.userId, note: input.note },
      ctx,
    });
    return { flag: toFlagView(flag), replayed: !created };
  });
}

/** Every optional reference of a manual flag must be a record of the same job (no cross-job or forged ids). */
async function assertRefsBelongToJob(tx: TenantTx, tenantId: string, jobId: string, input: RaiseFlagInput): Promise<void> {
  const checks: Array<[string, string | undefined, () => Promise<number>]> = [
    ["paymentId", input.paymentId, () => tx.payment.count({ where: { tenantId, jobId, id: input.paymentId } })],
    ["refundId", input.refundId, () => tx.refund.count({ where: { tenantId, jobId, id: input.refundId } })],
    ["chargebackId", input.chargebackId, () => tx.chargeback.count({ where: { tenantId, jobId, id: input.chargebackId } })],
    ["adjustmentId", input.adjustmentId, () => tx.adjustment.count({ where: { tenantId, jobId, id: input.adjustmentId } })],
    ["ledgerEntryId", input.ledgerEntryId, () => tx.ledgerEntry.count({ where: { tenantId, jobId, id: input.ledgerEntryId } })],
  ];
  for (const [field, value, count] of checks) {
    if (value !== undefined && (await count()) === 0) throw new ValidationError({ message: "The record does not belong to this job.", field: `body.${field}` });
  }
}

/**
 * `POST /finance/review-flags/{id}/assign`: gives the flag to someone (OPEN or ASSIGNED -> ASSIGNED; reassigning is
 * allowed). The assignee must be an active user of the tenant who can see the flag (`finance_reconciliation.view` over
 * its unit), so a flag is never handed to someone who cannot open it.
 */
export async function assignReviewFlag(actor: Actor, ctx: RequestContext, flagId: string, input: AssignFlagInput): Promise<FlagView> {
  return withTenant(actor.tenantId, async (tx) => {
    const flag = await loadFlagFor(tx, actor, flagId, "finance_reconciliation.assign");
    if (flag.status === "RESOLVED") throw invalidTransition(flag, "ASSIGNED");
    if (flag.status === "ASSIGNED" && flag.assignedToId === input.assigneeUserId) return toFlagView(flag);
    const assignee = await tx.user.findFirst({ where: { id: input.assigneeUserId, tenantId: actor.tenantId, status: "ACTIVE" }, select: { id: true } });
    const canSee = assignee ? (await canInTx(tx, { tenantId: actor.tenantId, userId: assignee.id }, READ, flagRef(flag))).allowed : false;
    if (!canSee) {
      const message = "The assignee must be an active user who can see this flag.";
      throw new ValidationError({ message, field: "body.assigneeUserId", details: [{ field: "body.assigneeUserId", code: "review_flag.assignee_cannot_see", message }] });
    }
    const updated = await tx.financeReviewFlag.update({ where: { id: flag.id }, data: { status: "ASSIGNED", assignedToId: assignee?.id, assignedAt: new Date() } });
    await auditChange(tx, ctx, "finance_review_flag.assign", flag, updated);
    return toFlagView(updated);
  });
}

/** `POST /finance/review-flags/{id}/unassign`: back to the open pool (ASSIGNED -> OPEN); replay when already OPEN. */
export async function unassignReviewFlag(actor: Actor, ctx: RequestContext, flagId: string): Promise<FlagView> {
  return withTenant(actor.tenantId, async (tx) => {
    const flag = await loadFlagFor(tx, actor, flagId, "finance_reconciliation.assign");
    if (flag.status === "OPEN") return toFlagView(flag);
    if (flag.status !== "ASSIGNED") throw invalidTransition(flag, "OPEN");
    const updated = await tx.financeReviewFlag.update({ where: { id: flag.id }, data: { status: "OPEN", assignedToId: null, assignedAt: null } });
    await auditChange(tx, ctx, "finance_review_flag.unassign", flag, updated);
    return toFlagView(updated);
  });
}

/**
 * `POST /finance/review-flags/{id}/resolve`: closes the flag with a reason (what finance did: "adjustment X posted",
 * "no change needed"). RESOLVED is final; a new concern is a new flag.
 */
export async function resolveReviewFlag(actor: Actor, ctx: RequestContext, flagId: string, input: ResolveFlagInput): Promise<FlagView> {
  return withTenant(actor.tenantId, async (tx) => {
    const flag = await loadFlagFor(tx, actor, flagId, "finance_reconciliation.edit");
    if (flag.status === "RESOLVED") throw invalidTransition(flag, "RESOLVED");
    const updated = await tx.financeReviewFlag.update({
      where: { id: flag.id },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: actor.userId, resolutionReason: input.resolutionReason },
    });
    await auditChange(tx, ctx, "finance_review_flag.resolve", flag, updated, input.resolutionReason);
    return toFlagView(updated);
  });
}

/** `GET /finance/review-flags`: flags in the caller's scope, newest first (`raisedAt desc, id desc`). */
export async function listReviewFlags(actor: Actor, query: ListFlagsQuery): Promise<Page<FlagView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, READ);
    const now = new Date();
    const scope = await resolveScope(tx, actor, READ, now);
    const filters: Prisma.FinanceReviewFlagWhereInput[] = [];
    if (query.status) filters.push({ status: query.status });
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.assignedToId) filters.push({ assignedToId: query.assignedToId });
    if (query.reasonCode) filters.push({ reasonCode: query.reasonCode });
    const rows = await tx.financeReviewFlag.findMany({
      where: withinScope(buildScopeWhere(scope, flagScopeColumns, now), { tenantId: actor.tenantId, AND: filters }),
      orderBy: [{ raisedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toFlagView), page: page.page };
  });
}

/** `GET /finance/review-flags/{id}` (outside the caller's scope = 404). */
export async function getReviewFlag(actor: Actor, flagId: string): Promise<FlagView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, READ);
    const flag = await tx.financeReviewFlag.findFirst({ where: { id: flagId, tenantId: actor.tenantId } });
    if (!flag) throw new NotFoundError();
    await enforceInTx(tx, actor, READ, flagRef(flag));
    return toFlagView(flag);
  });
}
