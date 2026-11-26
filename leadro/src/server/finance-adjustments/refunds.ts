import type { Prisma, Refund, RefundStatus } from "@prisma/client";
import { CANCELLABLE_REFUND_STATUSES, REVIEW_FLAG_REASONS } from "@/lib/finance-correction-rules";
import { cancelApprovalForSubjectInTx, createApprovalRequestInTx, type ApprovalOutcomeEvent } from "@/server/approvals";
import { recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope, type ResourceRef } from "@/server/authz";
import { ConflictError, InvalidStateTransitionError, NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { financeJobRef, financeJobScopeColumns, postLedgerEntryInTx, type FinanceJob } from "@/server/ledger";
import { deliverAfterCommit } from "@/server/notifications";
import { assertNotFuture, auditFields, FINANCE_REVIEW_SYSTEM_ACTOR, lockPayment, manualRecordKey, refusal, requireClientKey, requireFinanceJob } from "./common";
import { correctionApprovalKeys, correctionLedgerKeys, REFUND_SUBJECT, reviewFlagKeys } from "./keys";
import { remainingOnPaymentInTx } from "./payment-holdings";
import { raiseFinanceReviewFlagInTx } from "./review-flags";
import type { CompleteRefundInput, ListRefundsQuery, ReasonInput, RequestRefundInput } from "./schemas";

/**
 * Refunds (spec 11.1, 11.7, 25.4 "customer receives refund"). A refund is an explicit record against ONE received payment,
 * never an edit of the payment or of the ledger:
 *
 *   REQUESTED -> PENDING_APPROVAL (a REFUND policy applies) -> APPROVED | REJECTED | CANCELLED
 *   REQUESTED -> APPROVED (no policy: approval is not required) ;  APPROVED -> POSTED (paid out) | CANCELLED
 *
 * The money moves only when the refund is paid out (`completeRefund`): a REFUND ledger entry (negative, key
 * `refund:<id>:posted`) in the same transaction as POSTED. Partial refunds are allowed; the sum of a payment's refunds
 * (requested, waiting, approved or paid) and not-won chargebacks never exceeds the payment (checked under the payment row
 * lock). The DB machine (`refund_status`) and frozen columns (`refund_immutable`) back every rule here.
 *
 * A refund does not reduce what the customer was billed (docs/DECISIONS.md Phase 4 Task 4 "balance semantics"); if the
 * charge should also be forgiven, finance records a negative adjustment. Paying a refund raises a finance review flag
 * (`refund.posted`): any compensation that counted the money needs a person's decision, nothing changes automatically
 * (spec 11.7; compensation is blocked on the owner's specification).
 *
 * Permissions: request / pay out / cancel `finance_refunds.create`; read `finance_refunds.view`; decide = the policy's
 * approver permission (default `finance_refunds.approve`) through the approval engine, where the requester never decides.
 * Scope: the job's current service-area unit (`financeJobRef`), like payments.
 */

export type RefundView = Omit<Refund, "tenantId" | "idempotencyKey">;
export function toRefundView(refund: Refund): RefundView {
  const { tenantId: _tenantId, idempotencyKey: _key, ...view } = refund;
  return view;
}

/** The fields that identify a refund request: a replay under the same key must match them. */
const IDENTITY_FIELDS = ["paymentId", "amountMinor", "currency", "reason"] as const;

function invalid(refund: Refund, target: RefundStatus): InvalidStateTransitionError {
  const message = `A ${refund.status} refund cannot become ${target}.`;
  return new InvalidStateTransitionError({ message, details: [{ field: "status", code: "refund.invalid_transition", message }] });
}

async function loadRefund(tx: TenantTx, tenantId: string, refundId: string): Promise<{ refund: Refund; job: FinanceJob }> {
  const refund = await tx.refund.findFirst({ where: { id: refundId, tenantId } });
  if (!refund) throw new NotFoundError();
  return { refund, job: await requireFinanceJob(tx, tenantId, refund.jobId) };
}

/** Moves a refund from one of `from`; null when another transaction changed it first. */
async function transition(tx: TenantTx, refund: Refund, from: RefundStatus[], data: Prisma.RefundUncheckedUpdateManyInput & { status: RefundStatus }): Promise<Refund | null> {
  const { count } = await tx.refund.updateMany({ where: { id: refund.id, tenantId: refund.tenantId, status: { in: from } }, data });
  return count === 1 ? tx.refund.findFirstOrThrow({ where: { id: refund.id, tenantId: refund.tenantId } }) : null;
}

async function auditStatus(tx: TenantTx, ctx: RequestContext | null, action: string, before: Refund, after: Refund, extra: Record<string, unknown> = {}, reason?: string | null): Promise<void> {
  await recordAudit(tx, {
    ...auditFields(after.tenantId, ctx),
    action,
    targetType: "Refund",
    targetId: after.id,
    previousValue: { status: before.status },
    newValue: { status: after.status, jobId: after.jobId, paymentId: after.paymentId, amountMinor: after.amountMinor, currency: after.currency, ...extra },
    reason: reason ?? undefined,
  });
}

export interface RequestedRefund {
  refund: RefundView;
  replayed: boolean;
  approvalRequired: boolean;
  approvalRequestId: string | null;
}

/**
 * `POST /finance/refunds`: requests a (partial) refund of a RECEIVED payment. `finance_refunds.create` over the payment's
 * job; `Idempotency-Key` required (it becomes the refund's key). Opens a REFUND approval request when a policy applies
 * (the requester never decides it), else the refund is APPROVED at once.
 * @throws ValidationError (currency, no policy in the currency), ConflictError (payment not received, amount above what is
 *   left of the payment, key reused), NotFoundError / ForbiddenError.
 */
export async function requestRefund(actor: Actor, ctx: RequestContext, input: RequestRefundInput, clientKey: string | null): Promise<RequestedRefund> {
  const idempotencyKey = manualRecordKey(actor.userId, requireClientKey(clientKey, "refund.idempotency_key_required"));
  const result = await withTenant(actor.tenantId, async (tx) => {
    const tenantId = actor.tenantId;
    await enforceInTx(tx, actor, "finance_refunds.create");
    const payment = await lockPayment(tx, tenantId, input.paymentId);
    const job = await requireFinanceJob(tx, tenantId, payment.jobId);
    await enforceInTx(tx, actor, "finance_refunds.create", financeJobRef(job));

    const existing = await tx.refund.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } } });
    const currency = input.currency ?? payment.currency;
    if (existing) {
      const same = IDENTITY_FIELDS.every((field) => existing[field] === { paymentId: payment.id, amountMinor: input.amountMinor, currency, reason: input.reason }[field]);
      if (!same) throw refusal("conflict", "Idempotency-Key", "refund.idempotency_key_reused", "This idempotency key was already used for a different refund.");
      return { refund: existing, replayed: true, notificationIds: [] as string[] };
    }
    if (currency !== payment.currency) throw refusal("validation", "body.currency", "refund.currency_mismatch", "A refund must be in the payment's currency.");
    if (payment.status !== "RECEIVED") throw refusal("conflict", "body.paymentId", "refund.payment_not_received", "Only a received payment can be refunded.");
    const remaining = await remainingOnPaymentInTx(tx, tenantId, payment);
    if (input.amountMinor > remaining) {
      throw refusal("conflict", "body.amountMinor", "refund.exceeds_payment", "The refund is larger than what is left of the payment after earlier refunds and chargebacks.");
    }

    const created = await tx.refund.create({
      data: {
        tenantId,
        jobId: job.id,
        paymentId: payment.id,
        customerId: job.customerId,
        amountMinor: input.amountMinor,
        currency,
        reason: input.reason,
        orgUnitId: job.orgUnitId,
        idempotencyKey,
        requestedById: actor.userId,
      },
    });
    await recordAudit(tx, {
      ...auditFields(tenantId, ctx),
      action: "refund.request",
      targetType: "Refund",
      targetId: created.id,
      newValue: { status: created.status, jobId: job.id, paymentId: payment.id, amountMinor: created.amountMinor, currency, remainingBeforeMinor: remaining },
      reason: input.reason,
    });

    const approval = await createApprovalRequestInTx(tx, ctx, {
      tenantId,
      subjectType: REFUND_SUBJECT,
      subjectId: created.id,
      amount: { amountMinor: created.amountMinor, currency },
      jobId: job.id,
      customerId: job.customerId,
      reason: input.reason,
      details: { paymentId: payment.id, paymentAmountMinor: payment.amountMinor, amountMinor: created.amountMinor, currency, remainingBeforeMinor: remaining },
      idempotencyKey: correctionApprovalKeys.refund(created.id),
    });
    if (!approval.required) {
      const approved = await tx.refund.update({ where: { id: created.id }, data: { status: "APPROVED", decidedAt: new Date() } });
      await auditStatus(tx, ctx, "refund.approved", created, approved, { by: "no_policy" });
      return { refund: approved, replayed: false, notificationIds: [] as string[] };
    }
    const pending = await tx.refund.update({ where: { id: created.id }, data: { status: "PENDING_APPROVAL", approvalRequestId: approval.request.id } });
    return { refund: pending, replayed: false, notificationIds: approval.notificationIds };
  });
  await deliverAfterCommit(actor.tenantId, result.notificationIds);
  return {
    refund: toRefundView(result.refund),
    replayed: result.replayed,
    approvalRequired: result.refund.approvalRequestId !== null,
    approvalRequestId: result.refund.approvalRequestId,
  };
}

/**
 * `POST /finance/refunds/{id}/complete`: the approved refund was paid out. APPROVED -> POSTED and the REFUND ledger entry
 * (once: key `refund:<id>:posted`), plus a `refund.posted` finance review flag. The payment must still be RECEIVED (a
 * payment voided meanwhile has no money left to give back). `finance_refunds.create` over the job.
 */
export async function completeRefund(actor: Actor, ctx: RequestContext, refundId: string, input: CompleteRefundInput): Promise<{ refund: RefundView; replayed: boolean }> {
  assertNotFuture(input.refundedAt, "body.refundedAt");
  return withTenant(actor.tenantId, async (tx) => {
    const tenantId = actor.tenantId;
    await enforceInTx(tx, actor, "finance_refunds.create");
    const { refund: found, job } = await loadRefund(tx, tenantId, refundId);
    await enforceInTx(tx, actor, "finance_refunds.create", financeJobRef(job));
    // A refund always names its payment (the request requires it); the lock orders us against a concurrent void.
    const payment = found.paymentId ? await lockPayment(tx, tenantId, found.paymentId) : null;
    const refund = await tx.refund.findFirstOrThrow({ where: { id: refundId, tenantId } });
    if (refund.status === "POSTED") return { refund: toRefundView(refund), replayed: true };
    if (refund.status !== "APPROVED") throw invalid(refund, "POSTED");
    if (!payment || payment.status !== "RECEIVED") {
      throw refusal("conflict", "paymentId", "refund.payment_not_received", "The payment is no longer received (voided?); this refund cannot be paid out. Cancel it.");
    }

    const postedAt = input.refundedAt ?? new Date();
    const updated = await transition(tx, refund, ["APPROVED"], { status: "POSTED", postedAt, providerRef: input.reference ?? null });
    if (!updated) throw new ConflictError({ message: "The refund changed meanwhile; reload it.", retryable: true });
    const { entry } = await postLedgerEntryInTx(tx, {
      tenantId,
      type: "REFUND",
      source: "REFUND",
      amountMinor: -updated.amountMinor,
      currency: updated.currency,
      job,
      refs: { refundId: updated.id, paymentId: payment.id },
      idempotencyKey: correctionLedgerKeys.refundPosted(updated.id),
      actor: { userId: actor.userId },
      occurredAt: postedAt,
    });
    await auditStatus(tx, ctx, "refund.post", refund, updated, { ledgerEntryId: entry.id, hasReference: input.reference !== undefined });
    await raiseFinanceReviewFlagInTx(tx, {
      tenantId,
      reasonCode: REVIEW_FLAG_REASONS.refundPosted,
      idempotencyKey: reviewFlagKeys.refundPosted(updated.id),
      refs: { jobId: job.id, customerId: job.customerId, paymentId: payment.id, refundId: updated.id, ledgerEntryId: entry.id },
      orgUnitId: job.orgUnitId,
      details: { refundId: updated.id, amountMinor: updated.amountMinor, currency: updated.currency },
      raisedBy: { system: FINANCE_REVIEW_SYSTEM_ACTOR },
      ctx,
    });
    return { refund: toRefundView(updated), replayed: false };
  });
}

/**
 * `POST /finance/refunds/{id}/cancel`: withdraws a refund that was not paid out (REQUESTED, PENDING_APPROVAL, APPROVED ->
 * CANCELLED), cancelling its pending approval request. The requester may always cancel their own; anyone else needs
 * `finance_refunds.create` over the job. Nothing was posted, so nothing is reversed.
 */
export async function cancelRefund(actor: Actor, ctx: RequestContext, refundId: string, input: ReasonInput): Promise<{ refund: RefundView; replayed: boolean }> {
  return withTenant(actor.tenantId, async (tx) => {
    const tenantId = actor.tenantId;
    const { refund, job } = await loadRefund(tx, tenantId, refundId);
    // Even the requester must still see the refund: losing finance access ends their control of it too (spec 25.5).
    await enforceInTx(tx, actor, "finance_refunds.view", financeJobRef(job));
    if (refund.requestedById !== actor.userId) await enforceInTx(tx, actor, "finance_refunds.create", financeJobRef(job));
    if (refund.status === "CANCELLED") return { refund: toRefundView(refund), replayed: true };
    if (!CANCELLABLE_REFUND_STATUSES.includes(refund.status)) throw invalid(refund, "CANCELLED");
    const updated = await transition(tx, refund, [...CANCELLABLE_REFUND_STATUSES], { status: "CANCELLED" });
    if (!updated) throw new ConflictError({ message: "The refund changed meanwhile; reload it.", retryable: true });
    if (refund.status === "PENDING_APPROVAL") {
      await cancelApprovalForSubjectInTx(tx, ctx, { tenantId, subjectType: REFUND_SUBJECT, subjectId: refund.id, reason: input.reason });
    }
    await auditStatus(tx, ctx, "refund.cancel", refund, updated, {}, input.reason);
    return { refund: toRefundView(updated), replayed: false };
  });
}

/** Approval engine callback (the deciding transaction): PENDING_APPROVAL -> APPROVED. */
export async function onRefundApproved(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const refund = await tx.refund.findFirst({ where: { id: event.subjectId, tenantId: event.tenantId } });
  if (!refund || refund.status !== "PENDING_APPROVAL") return;
  const updated = await transition(tx, refund, ["PENDING_APPROVAL"], { status: "APPROVED", decidedAt: event.now });
  if (updated) await auditStatus(tx, event.ctx, "refund.approved", refund, updated, { approvalRequestId: event.requestId, approverIds: event.approverIds });
}

/** Approval engine callback: rejected or expired -> REJECTED; cancelled through the approvals API -> CANCELLED. */
export async function onRefundRejected(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const refund = await tx.refund.findFirst({ where: { id: event.subjectId, tenantId: event.tenantId } });
  if (!refund || refund.status !== "PENDING_APPROVAL") return;
  const target: RefundStatus = event.outcome === "CANCELLED" ? "CANCELLED" : "REJECTED";
  const data = target === "REJECTED" ? { status: target, decidedAt: event.now } : { status: target };
  const updated = await transition(tx, refund, ["PENDING_APPROVAL"], data);
  if (updated) await auditStatus(tx, event.ctx, target === "REJECTED" ? "refund.rejected" : "refund.cancel", refund, updated, { approvalRequestId: event.requestId, outcome: event.outcome }, event.reason);
}

/** The scope of a refund for the approval engine and the route resolvers: its job's current unit; null when missing. */
export async function refundResourceRef(tx: TenantTx, tenantId: string, refundId: string): Promise<ResourceRef | null> {
  const refund = await tx.refund.findFirst({ where: { id: refundId, tenantId }, select: { job: { select: { orgUnitId: true } } } });
  return refund ? financeJobRef(refund.job) : null;
}

/** `GET /finance/refunds`: refunds in the caller's scope (through the job), newest first (`requestedAt desc, id desc`). */
export async function listRefunds(actor: Actor, query: ListRefundsQuery): Promise<Page<RefundView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_refunds.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_refunds.view", now);
    const filters: Prisma.RefundWhereInput[] = [];
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.paymentId) filters.push({ paymentId: query.paymentId });
    if (query.status) filters.push({ status: query.status });
    const rows = await tx.refund.findMany({
      where: withinScope<Prisma.RefundWhereInput>({ job: buildScopeWhere(scope, financeJobScopeColumns, now) }, { tenantId: actor.tenantId, AND: filters }),
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toRefundView), page: page.page };
  });
}

/** `GET /finance/refunds/{id}` (outside the caller's scope = 404). */
export async function getRefund(actor: Actor, refundId: string): Promise<RefundView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_refunds.view");
    const { refund, job } = await loadRefund(tx, actor.tenantId, refundId);
    await enforceInTx(tx, actor, "finance_refunds.view", financeJobRef(job));
    return toRefundView(refund);
  });
}
