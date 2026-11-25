import type { Adjustment, AdjustmentStatus, Prisma } from "@prisma/client";
import { cancelApprovalForSubjectInTx, createApprovalRequestInTx, type ApprovalOutcomeEvent } from "@/server/approvals";
import { recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope, type ResourceRef } from "@/server/authz";
import { ConflictError, InvalidStateTransitionError, NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { financeJobRef, financeJobScopeColumns, postLedgerEntryInTx, type FinanceJob, type LedgerActor } from "@/server/ledger";
import { deliverAfterCommit } from "@/server/notifications";
import { auditFields, ledgerActorOf, manualRecordKey, refusal, requireClientKey, requireFinanceJob } from "./common";
import { ADJUSTMENT_SUBJECT, correctionApprovalKeys, correctionLedgerKeys } from "./keys";
import type { ListAdjustmentsQuery, ReasonInput, RequestAdjustmentInput } from "./schemas";

/**
 * Adjustments (spec 11.1, 11.7, 11.8, 25.4): the explicit correction of what a customer owes on a job. Positive = a debit
 * (the customer owes more), negative = a credit; never zero. It is the ONLY way to change billed money after the fact: a
 * reopened job, a corrected outcome, a price change or goodwill never edits a posted entry (append-only ledger), it posts an
 * ADJUSTMENT entry (key `adjustment:<id>:posted`) linked to the adjustment record.
 *
 *   PENDING_APPROVAL -> APPROVED -> POSTED (in the same transaction: an adjustment moves no outside money, so approved means
 *   posted) ; PENDING_APPROVAL -> REJECTED | CANCELLED
 *
 * Without an ADJUSTMENT policy for the amount the adjustment is approved and posted at once. The policy band is matched on
 * the ABSOLUTE amount (a large credit needs the same scrutiny as a large debit). A posted adjustment is never undone in
 * place: a mistaken one is corrected by a counter-adjustment (its own record, reason and approval).
 *
 * An adjustment is about a customer's job only: it never deducts from an employee's wages and never touches commission
 * (spec 11.7, 28.4); the input has no employee field at all.
 *
 * Permissions: request / cancel `finance_adjustments.create`; read `finance_adjustments.view`; decide = the policy's
 * approver permission (default `finance_adjustments.approve`). Scope: the job's current unit.
 */

export type AdjustmentView = Omit<Adjustment, "tenantId" | "idempotencyKey">;
export function toAdjustmentView(adjustment: Adjustment): AdjustmentView {
  const { tenantId: _tenantId, idempotencyKey: _key, ...view } = adjustment;
  return view;
}

const IDENTITY_FIELDS = ["jobId", "amountMinor", "currency", "reasonCode", "reason", "outcomeId"] as const;

const absolute = (amount: bigint): bigint => (amount < 0n ? -amount : amount);

function invalid(adjustment: Adjustment, target: AdjustmentStatus): InvalidStateTransitionError {
  const message = `A ${adjustment.status} adjustment cannot become ${target}.`;
  return new InvalidStateTransitionError({ message, details: [{ field: "status", code: "adjustment.invalid_transition", message }] });
}

async function transition(tx: TenantTx, adjustment: Adjustment, from: AdjustmentStatus[], data: Prisma.AdjustmentUncheckedUpdateManyInput & { status: AdjustmentStatus }): Promise<Adjustment | null> {
  const { count } = await tx.adjustment.updateMany({ where: { id: adjustment.id, tenantId: adjustment.tenantId, status: { in: from } }, data });
  return count === 1 ? tx.adjustment.findFirstOrThrow({ where: { id: adjustment.id, tenantId: adjustment.tenantId } }) : null;
}

async function auditStatus(tx: TenantTx, ctx: RequestContext | null, action: string, before: Adjustment | null, after: Adjustment, extra: Record<string, unknown> = {}, reason?: string | null): Promise<void> {
  await recordAudit(tx, {
    ...auditFields(after.tenantId, ctx),
    action,
    targetType: "Adjustment",
    targetId: after.id,
    previousValue: before ? { status: before.status } : undefined,
    newValue: { status: after.status, jobId: after.jobId, amountMinor: after.amountMinor, currency: after.currency, reasonCode: after.reasonCode, ...extra },
    reason: reason ?? undefined,
  });
}

/**
 * Posts an APPROVED adjustment: APPROVED -> POSTED and its ADJUSTMENT ledger entry, in the caller's transaction. Shared by
 * the direct path (no policy), the approval callback and the chargeback write-off. Idempotent: an adjustment already
 * POSTED is returned as is (the ledger key makes a second posting impossible anyway).
 */
export async function postApprovedAdjustmentInTx(tx: TenantTx, ctx: RequestContext | null, adjustment: Adjustment, job: FinanceJob, actor: LedgerActor): Promise<Adjustment> {
  if (adjustment.status === "POSTED") return adjustment;
  const postedAt = new Date();
  const posted = await transition(tx, adjustment, ["APPROVED"], { status: "POSTED", postedAt });
  if (!posted) throw invalid(adjustment, "POSTED");
  const { entry } = await postLedgerEntryInTx(tx, {
    tenantId: posted.tenantId,
    type: "ADJUSTMENT",
    source: "ADJUSTMENT",
    amountMinor: posted.amountMinor,
    currency: posted.currency,
    job,
    refs: { adjustmentId: posted.id, ...(posted.outcomeId ? { outcomeId: posted.outcomeId } : {}) },
    idempotencyKey: correctionLedgerKeys.adjustmentPosted(posted.id),
    actor,
    occurredAt: postedAt,
  });
  await auditStatus(tx, ctx, "adjustment.post", adjustment, posted, { ledgerEntryId: entry.id });
  return posted;
}

export interface RequestedAdjustment {
  adjustment: AdjustmentView;
  replayed: boolean;
  approvalRequired: boolean;
  approvalRequestId: string | null;
}

/**
 * `POST /finance/adjustments`: requests a credit or debit on a job with a reason. `finance_adjustments.create` over the job;
 * `Idempotency-Key` required. Opens an ADJUSTMENT approval request when a policy applies, else approves and posts at once.
 * @throws ValidationError (currency, outcome of another job, no policy in the currency), ConflictError (key reused).
 */
export async function requestAdjustment(actor: Actor, ctx: RequestContext, input: RequestAdjustmentInput, clientKey: string | null): Promise<RequestedAdjustment> {
  const idempotencyKey = manualRecordKey(actor.userId, requireClientKey(clientKey, "adjustment.idempotency_key_required"));
  const result = await withTenant(actor.tenantId, async (tx) => {
    const tenantId = actor.tenantId;
    await enforceInTx(tx, actor, "finance_adjustments.create");
    const job = await requireFinanceJob(tx, tenantId, input.jobId);
    await enforceInTx(tx, actor, "finance_adjustments.create", financeJobRef(job));
    const currency = input.currency ?? job.currency;
    const wanted = { jobId: job.id, amountMinor: input.amountMinor, currency, reasonCode: input.reasonCode, reason: input.reason, outcomeId: input.outcomeId ?? null };

    const existing = await tx.adjustment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } } });
    if (existing) {
      if (!IDENTITY_FIELDS.every((field) => existing[field] === wanted[field])) {
        throw refusal("conflict", "Idempotency-Key", "adjustment.idempotency_key_reused", "This idempotency key was already used for a different adjustment.");
      }
      return { adjustment: existing, replayed: true, notificationIds: [] as string[] };
    }
    if (currency !== job.currency) throw refusal("validation", "body.currency", "adjustment.currency_mismatch", "An adjustment must be in the job's currency.");
    if (input.outcomeId && (await tx.jobOutcome.count({ where: { tenantId, id: input.outcomeId, jobId: job.id } })) === 0) {
      throw refusal("validation", "body.outcomeId", "adjustment.outcome_not_of_job", "The outcome does not belong to this job.");
    }

    const created = await tx.adjustment.create({
      data: { tenantId, ...wanted, customerId: job.customerId, orgUnitId: job.orgUnitId, idempotencyKey, requestedById: actor.userId },
    });
    await auditStatus(tx, ctx, "adjustment.request", null, created, { direction: created.amountMinor > 0n ? "DEBIT" : "CREDIT" }, input.reason);

    const approval = await createApprovalRequestInTx(tx, ctx, {
      tenantId,
      subjectType: ADJUSTMENT_SUBJECT,
      subjectId: created.id,
      // §21.3: thresholds compare the size of the correction, whichever way it goes.
      amount: { amountMinor: absolute(created.amountMinor), currency },
      jobId: job.id,
      customerId: job.customerId,
      reason: input.reason,
      details: { amountMinor: created.amountMinor, currency, direction: created.amountMinor > 0n ? "DEBIT" : "CREDIT", reasonCode: input.reasonCode, outcomeId: created.outcomeId },
      idempotencyKey: correctionApprovalKeys.adjustment(created.id),
    });
    if (!approval.required) {
      const approved = await tx.adjustment.update({ where: { id: created.id }, data: { status: "APPROVED", decidedAt: new Date() } });
      await auditStatus(tx, ctx, "adjustment.approved", created, approved, { by: "no_policy" });
      const posted = await postApprovedAdjustmentInTx(tx, ctx, approved, job, { userId: actor.userId });
      return { adjustment: posted, replayed: false, notificationIds: [] as string[] };
    }
    const pending = await tx.adjustment.update({ where: { id: created.id }, data: { approvalRequestId: approval.request.id } });
    return { adjustment: pending, replayed: false, notificationIds: approval.notificationIds };
  });
  await deliverAfterCommit(actor.tenantId, result.notificationIds);
  return {
    adjustment: toAdjustmentView(result.adjustment),
    replayed: result.replayed,
    approvalRequired: result.adjustment.approvalRequestId !== null,
    approvalRequestId: result.adjustment.approvalRequestId,
  };
}

async function loadAdjustment(tx: TenantTx, tenantId: string, adjustmentId: string): Promise<{ adjustment: Adjustment; job: FinanceJob }> {
  const adjustment = await tx.adjustment.findFirst({ where: { id: adjustmentId, tenantId } });
  // Every adjustment this module creates names a job (the ledger posts against jobs); a customer-only row is not ours.
  if (!adjustment || !adjustment.jobId) throw new NotFoundError();
  return { adjustment, job: await requireFinanceJob(tx, tenantId, adjustment.jobId) };
}

/**
 * `POST /finance/adjustments/{id}/cancel`: withdraws a pending adjustment (PENDING_APPROVAL -> CANCELLED) and its approval
 * request. The requester may cancel their own; anyone else needs `finance_adjustments.create` over the job. A POSTED
 * adjustment cannot be cancelled: correct it with a counter-adjustment.
 */
export async function cancelAdjustment(actor: Actor, ctx: RequestContext, adjustmentId: string, input: ReasonInput): Promise<{ adjustment: AdjustmentView; replayed: boolean }> {
  return withTenant(actor.tenantId, async (tx) => {
    const { adjustment, job } = await loadAdjustment(tx, actor.tenantId, adjustmentId);
    await enforceInTx(tx, actor, "finance_adjustments.view", financeJobRef(job));
    if (adjustment.requestedById !== actor.userId) await enforceInTx(tx, actor, "finance_adjustments.create", financeJobRef(job));
    if (adjustment.status === "CANCELLED") return { adjustment: toAdjustmentView(adjustment), replayed: true };
    if (adjustment.status !== "PENDING_APPROVAL") throw invalid(adjustment, "CANCELLED");
    const updated = await transition(tx, adjustment, ["PENDING_APPROVAL"], { status: "CANCELLED" });
    if (!updated) throw new ConflictError({ message: "The adjustment changed meanwhile; reload it.", retryable: true });
    await cancelApprovalForSubjectInTx(tx, ctx, { tenantId: actor.tenantId, subjectType: ADJUSTMENT_SUBJECT, subjectId: adjustment.id, reason: input.reason });
    await auditStatus(tx, ctx, "adjustment.cancel", adjustment, updated, {}, input.reason);
    return { adjustment: toAdjustmentView(updated), replayed: false };
  });
}

/** Approval engine callback: APPROVED and POSTED in the deciding transaction; the deciding approver is the ledger actor. */
export async function onAdjustmentApproved(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const adjustment = await tx.adjustment.findFirst({ where: { id: event.subjectId, tenantId: event.tenantId } });
  if (!adjustment?.jobId || adjustment.status !== "PENDING_APPROVAL") return;
  const job = await requireFinanceJob(tx, event.tenantId, adjustment.jobId);
  const approved = await transition(tx, adjustment, ["PENDING_APPROVAL"], { status: "APPROVED", decidedAt: event.now });
  if (!approved) return;
  await auditStatus(tx, event.ctx, "adjustment.approved", adjustment, approved, { approvalRequestId: event.requestId, approverIds: event.approverIds });
  await postApprovedAdjustmentInTx(tx, event.ctx, approved, job, ledgerActorOf(event.ctx));
}

/** Approval engine callback: rejected or expired -> REJECTED; cancelled through the approvals API -> CANCELLED. */
export async function onAdjustmentRejected(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const adjustment = await tx.adjustment.findFirst({ where: { id: event.subjectId, tenantId: event.tenantId } });
  if (!adjustment || adjustment.status !== "PENDING_APPROVAL") return;
  const target: AdjustmentStatus = event.outcome === "CANCELLED" ? "CANCELLED" : "REJECTED";
  const updated = await transition(tx, adjustment, ["PENDING_APPROVAL"], target === "REJECTED" ? { status: target, decidedAt: event.now } : { status: target });
  if (updated) {
    await auditStatus(tx, event.ctx, target === "REJECTED" ? "adjustment.rejected" : "adjustment.cancel", adjustment, updated, { approvalRequestId: event.requestId, outcome: event.outcome }, event.reason);
  }
}

/** The scope of an adjustment (its job's current unit); null when missing or not job-bound. */
export async function adjustmentResourceRef(tx: TenantTx, tenantId: string, adjustmentId: string): Promise<ResourceRef | null> {
  const adjustment = await tx.adjustment.findFirst({ where: { id: adjustmentId, tenantId }, select: { job: { select: { orgUnitId: true } } } });
  return adjustment?.job ? financeJobRef(adjustment.job) : null;
}

/** `GET /finance/adjustments`: adjustments in the caller's scope (through the job), newest first. */
export async function listAdjustments(actor: Actor, query: ListAdjustmentsQuery): Promise<Page<AdjustmentView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_adjustments.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_adjustments.view", now);
    const filters: Prisma.AdjustmentWhereInput[] = [];
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.status) filters.push({ status: query.status });
    if (query.reasonCode) filters.push({ reasonCode: query.reasonCode });
    const rows = await tx.adjustment.findMany({
      where: withinScope<Prisma.AdjustmentWhereInput>({ job: buildScopeWhere(scope, financeJobScopeColumns, now) }, { tenantId: actor.tenantId, AND: filters }),
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toAdjustmentView), page: page.page };
  });
}

/** `GET /finance/adjustments/{id}` (outside the caller's scope = 404). */
export async function getAdjustment(actor: Actor, adjustmentId: string): Promise<AdjustmentView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_adjustments.view");
    const { adjustment, job } = await loadAdjustment(tx, actor.tenantId, adjustmentId);
    await enforceInTx(tx, actor, "finance_adjustments.view", financeJobRef(job));
    return toAdjustmentView(adjustment);
  });
}
