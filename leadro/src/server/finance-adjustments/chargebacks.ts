import type { Chargeback, ChargebackStatus, Payment, Prisma } from "@prisma/client";
import { CHARGEBACK_WRITE_OFF_REASON_CODE, chargebackTransitionAllowed, REVIEW_FLAG_REASONS } from "@/lib/finance-correction-rules";
import { createApprovalRequestInTx, type ApprovalOutcomeEvent } from "@/server/approvals";
import { recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope, type ResourceRef } from "@/server/authz";
import { ConflictError, InvalidStateTransitionError, NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { financeJobRef, financeJobScopeColumns, postLedgerEntryInTx, reverseLedgerEntryInTx, type FinanceJob, type LedgerActor } from "@/server/ledger";
import { deliverAfterCommit } from "@/server/notifications";
import { postApprovedAdjustmentInTx } from "./adjustments";
import { assertNotFuture, auditFields, FINANCE_REVIEW_SYSTEM_ACTOR, ledgerActorOf, lockPayment, manualRecordKey, refusal, requireClientKey, requireFinanceJob } from "./common";
import { CHARGEBACK_WRITE_OFF_SUBJECT, chargebackWriteOffAdjustmentKey, correctionApprovalKeys, correctionLedgerKeys, reviewFlagKeys } from "./keys";
import { remainingOnPaymentInTx } from "./payment-holdings";
import { raiseFinanceReviewFlagInTx } from "./review-flags";
import type { ChargebackNotesInput, ListChargebacksQuery, ReasonInput, RecordChargebackInput } from "./schemas";

/**
 * Chargebacks (spec 11.7, 25.4 "chargeback occurs"): a customer disputed a card payment and the processor took the money
 * back. Recorded from the provider intake (`chargeback.opened`, see `chargeback-intake.ts`) or by hand from the
 * processor's notice, always against ONE payment.
 *
 *   OPEN -> DISPUTED -> WON | LOST ; OPEN -> WON | LOST ; LOST -> WRITE_OFF_PENDING_APPROVAL -> WRITTEN_OFF | LOST ;
 *   LOST -> WRITTEN_OFF (no write-off policy)
 *
 * Money: opening posts the CHARGEBACK entry (negative, key `chargeback:<id>:opened`): the processor debits the funds when
 * the dispute opens. WON posts the REVERSAL of that entry (key `chargeback:<id>:won`): the money came back. LOST changes no
 * money (it stays charged back). A write-off (the receivable will not be collected) needs a CHARGEBACK_WRITE_OFF approval
 * when a policy applies; it posts a system ADJUSTMENT of minus the chargeback amount (reason code `chargeback_write_off`,
 * key `chargeback:<id>:write_off`), so what the customer is billed for drops by exactly the lost amount. Nothing is ever
 * edited or deleted; every opening raises a `chargeback.opened` finance review flag (no automatic commission effect).
 *
 * Permissions: record `finance_chargebacks.create`; dispute / won / lost / request a write-off `finance_chargebacks.edit`;
 * read `finance_chargebacks.view`; decide a write-off = the policy's approver permission (default
 * `finance_chargebacks.approve`). The write-off requester and the person who recorded the chargeback never decide it.
 */

export type ChargebackView = Omit<Chargeback, "tenantId" | "idempotencyKey">;
export function toChargebackView(chargeback: Chargeback): ChargebackView {
  const { tenantId: _tenantId, idempotencyKey: _key, ...view } = chargeback;
  return view;
}

const IDENTITY_FIELDS = ["paymentId", "amountMinor", "currency"] as const;

function invalid(chargeback: Chargeback, target: ChargebackStatus): InvalidStateTransitionError {
  const message = `A ${chargeback.status} chargeback cannot become ${target}.`;
  return new InvalidStateTransitionError({ message, details: [{ field: "status", code: "chargeback.invalid_transition", message }] });
}

async function transition(tx: TenantTx, chargeback: Chargeback, from: ChargebackStatus[], data: Prisma.ChargebackUncheckedUpdateManyInput & { status: ChargebackStatus }): Promise<Chargeback | null> {
  const { count } = await tx.chargeback.updateMany({ where: { id: chargeback.id, tenantId: chargeback.tenantId, status: { in: from } }, data });
  return count === 1 ? tx.chargeback.findFirstOrThrow({ where: { id: chargeback.id, tenantId: chargeback.tenantId } }) : null;
}

async function auditStatus(tx: TenantTx, ctx: RequestContext | null, action: string, before: Chargeback | null, after: Chargeback, extra: Record<string, unknown> = {}, reason?: string | null): Promise<void> {
  await recordAudit(tx, {
    ...auditFields(after.tenantId, ctx),
    action,
    targetType: "Chargeback",
    targetId: after.id,
    previousValue: before ? { status: before.status } : undefined,
    newValue: { status: after.status, jobId: after.jobId, paymentId: after.paymentId, amountMinor: after.amountMinor, currency: after.currency, ...extra },
    reason: reason ?? undefined,
  });
}

export interface OpenChargebackInput {
  tenantId: string;
  job: FinanceJob;
  payment: Payment;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
  reasonCode: string | null;
  notes: string | null;
  openedAt: Date;
  provider?: { key: string; chargebackRef: string; intakeEventId: string };
  recordedById: string | null;
  actor: LedgerActor;
  ctx: RequestContext | null;
}

/**
 * Creates an OPEN chargeback, posts its CHARGEBACK entry and raises the `chargeback.opened` review flag, in the caller's
 * transaction (manual recording or provider intake). The caller holds the payment lock and has validated the input.
 */
export async function openChargebackInTx(tx: TenantTx, input: OpenChargebackInput): Promise<Chargeback> {
  const remaining = await remainingOnPaymentInTx(tx, input.tenantId, input.payment);
  const created = await tx.chargeback.create({
    data: {
      tenantId: input.tenantId,
      jobId: input.job.id,
      paymentId: input.payment.id,
      customerId: input.job.customerId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      reasonCode: input.reasonCode,
      notes: input.notes,
      provider: input.provider?.key ?? null,
      providerRef: input.provider?.chargebackRef ?? null,
      intakeEventId: input.provider?.intakeEventId ?? null,
      orgUnitId: input.job.orgUnitId,
      idempotencyKey: input.idempotencyKey,
      openedAt: input.openedAt,
      recordedById: input.recordedById,
    },
  });
  const { entry } = await postLedgerEntryInTx(tx, {
    tenantId: input.tenantId,
    type: "CHARGEBACK",
    source: "CHARGEBACK",
    amountMinor: -created.amountMinor,
    currency: created.currency,
    job: input.job,
    refs: { chargebackId: created.id, paymentId: input.payment.id },
    idempotencyKey: correctionLedgerKeys.chargebackOpened(created.id),
    actor: input.actor,
    occurredAt: created.openedAt,
  });
  await auditStatus(tx, input.ctx, "chargeback.record", null, created, { ledgerEntryId: entry.id, origin: input.provider ? "PROVIDER" : "MANUAL" });
  await raiseFinanceReviewFlagInTx(tx, {
    tenantId: input.tenantId,
    reasonCode: REVIEW_FLAG_REASONS.chargebackOpened,
    idempotencyKey: reviewFlagKeys.chargebackOpened(created.id),
    refs: { jobId: input.job.id, customerId: input.job.customerId, paymentId: input.payment.id, chargebackId: created.id, ledgerEntryId: entry.id },
    orgUnitId: input.job.orgUnitId,
    // A provider chargeback is never refused (the money is gone already); "more than was left" is for finance to look at.
    details: { chargebackId: created.id, amountMinor: created.amountMinor, currency: created.currency, exceedsRemaining: created.amountMinor > remaining },
    raisedBy: { system: FINANCE_REVIEW_SYSTEM_ACTOR },
    ctx: input.ctx,
  });
  return created;
}

/**
 * `POST /finance/chargebacks`: records a chargeback by hand (from the processor's notice) against a RECEIVED payment.
 * `finance_chargebacks.create` over the job; `Idempotency-Key` required. The amount may not exceed what is left of the
 * payment after earlier refunds and chargebacks (a person typing it can be wrong; the provider intake is not refused).
 */
export async function recordChargeback(actor: Actor, ctx: RequestContext, input: RecordChargebackInput, clientKey: string | null): Promise<{ chargeback: ChargebackView; replayed: boolean }> {
  const idempotencyKey = manualRecordKey(actor.userId, requireClientKey(clientKey, "chargeback.idempotency_key_required"));
  assertNotFuture(input.openedAt, "body.openedAt");
  return withTenant(actor.tenantId, async (tx) => {
    const tenantId = actor.tenantId;
    await enforceInTx(tx, actor, "finance_chargebacks.create");
    const payment = await lockPayment(tx, tenantId, input.paymentId);
    const job = await requireFinanceJob(tx, tenantId, payment.jobId);
    await enforceInTx(tx, actor, "finance_chargebacks.create", financeJobRef(job));
    const currency = input.currency ?? payment.currency;

    const existing = await tx.chargeback.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } } });
    if (existing) {
      const wanted = { paymentId: payment.id, amountMinor: input.amountMinor, currency };
      if (!IDENTITY_FIELDS.every((field) => existing[field] === wanted[field])) {
        throw refusal("conflict", "Idempotency-Key", "chargeback.idempotency_key_reused", "This idempotency key was already used for a different chargeback.");
      }
      return { chargeback: toChargebackView(existing), replayed: true };
    }
    if (currency !== payment.currency) throw refusal("validation", "body.currency", "chargeback.currency_mismatch", "A chargeback must be in the payment's currency.");
    if (payment.status !== "RECEIVED") throw refusal("conflict", "body.paymentId", "chargeback.payment_not_received", "Only a received payment can be charged back.");
    if (input.amountMinor > (await remainingOnPaymentInTx(tx, tenantId, payment))) {
      throw refusal("conflict", "body.amountMinor", "chargeback.exceeds_payment", "The chargeback is larger than what is left of the payment after refunds and chargebacks.");
    }
    const created = await openChargebackInTx(tx, {
      tenantId,
      job,
      payment,
      amountMinor: input.amountMinor,
      currency,
      idempotencyKey,
      reasonCode: input.reasonCode ?? null,
      notes: input.notes ?? null,
      openedAt: input.openedAt ?? new Date(),
      recordedById: actor.userId,
      actor: { userId: actor.userId },
      ctx,
    });
    return { chargeback: toChargebackView(created), replayed: false };
  });
}

async function loadForEdit(tx: TenantTx, actor: Actor, chargebackId: string): Promise<{ chargeback: Chargeback; job: FinanceJob }> {
  await enforceInTx(tx, actor, "finance_chargebacks.edit");
  await tx.$queryRaw`SELECT "id" FROM "Chargeback" WHERE "id" = ${chargebackId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
  const chargeback = await tx.chargeback.findFirst({ where: { id: chargebackId, tenantId: actor.tenantId } });
  if (!chargeback) throw new NotFoundError();
  const job = await requireFinanceJob(tx, actor.tenantId, chargeback.jobId);
  await enforceInTx(tx, actor, "finance_chargebacks.edit", financeJobRef(job));
  return { chargeback, job };
}

/** Shared step of dispute / won / lost: allowed edge or replay when already there. */
async function move(actor: Actor, ctx: RequestContext, chargebackId: string, target: ChargebackStatus, notes: string | undefined, apply: (tx: TenantTx, chargeback: Chargeback, updated: Chargeback) => Promise<Record<string, unknown>>): Promise<{ chargeback: ChargebackView; replayed: boolean }> {
  return withTenant(actor.tenantId, async (tx) => {
    const { chargeback } = await loadForEdit(tx, actor, chargebackId);
    if (chargeback.status === target) return { chargeback: toChargebackView(chargeback), replayed: true };
    if (!chargebackTransitionAllowed(chargeback.status, target)) throw invalid(chargeback, target);
    const resolves = target === "WON" || target === "LOST";
    const updated = await transition(tx, chargeback, [chargeback.status], {
      status: target,
      ...(resolves ? { resolvedAt: new Date() } : {}),
      ...(notes !== undefined ? { notes } : {}),
    });
    if (!updated) throw new ConflictError({ message: "The chargeback changed meanwhile; reload it.", retryable: true });
    const extra = await apply(tx, chargeback, updated);
    await auditStatus(tx, ctx, `chargeback.${target.toLowerCase()}`, chargeback, updated, extra);
    return { chargeback: toChargebackView(updated), replayed: false };
  });
}

/** `POST /finance/chargebacks/{id}/dispute`: evidence was submitted to the processor (OPEN -> DISPUTED). No money moves. */
export function disputeChargeback(actor: Actor, ctx: RequestContext, chargebackId: string, input: ChargebackNotesInput): Promise<{ chargeback: ChargebackView; replayed: boolean }> {
  return move(actor, ctx, chargebackId, "DISPUTED", input.notes, async () => ({}));
}

/** `POST /finance/chargebacks/{id}/won`: the dispute was won; the CHARGEBACK entry is REVERSED (the money came back). */
export function markChargebackWon(actor: Actor, ctx: RequestContext, chargebackId: string, input: ChargebackNotesInput): Promise<{ chargeback: ChargebackView; replayed: boolean }> {
  return move(actor, ctx, chargebackId, "WON", input.notes, async (tx, chargeback) => {
    const opened = await tx.ledgerEntry.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: chargeback.tenantId, idempotencyKey: correctionLedgerKeys.chargebackOpened(chargeback.id) } },
      select: { id: true },
    });
    // Every chargeback is posted in the transaction that opens it; a missing entry would be a broken invariant.
    if (!opened) throw new Error(`chargeback ${chargeback.id} has no CHARGEBACK entry`);
    const { entry } = await reverseLedgerEntryInTx(tx, {
      tenantId: chargeback.tenantId,
      entryId: opened.id,
      actor: { userId: actor.userId },
      reason: "Chargeback dispute won",
      idempotencyKey: correctionLedgerKeys.chargebackWon(chargeback.id),
    });
    return { reversalEntryId: entry.id };
  });
}

/** `POST /finance/chargebacks/{id}/lost`: the dispute was lost (or not contested); the money stays charged back. */
export function markChargebackLost(actor: Actor, ctx: RequestContext, chargebackId: string, input: ChargebackNotesInput): Promise<{ chargeback: ChargebackView; replayed: boolean }> {
  return move(actor, ctx, chargebackId, "LOST", input.notes, async () => ({}));
}

/**
 * Writes a LOST (or pending) chargeback off: WRITTEN_OFF plus the system adjustment of minus its amount, posted. Called
 * directly when no policy applies and from the approval callback. `requestedById` is the write-off requester.
 */
async function writeOffInTx(tx: TenantTx, ctx: RequestContext | null, chargeback: Chargeback, from: ChargebackStatus, reason: string, requestedById: string | null, approvalRequestId: string | null, ledgerActor: LedgerActor): Promise<Chargeback> {
  const job = await requireFinanceJob(tx, chargeback.tenantId, chargeback.jobId);
  const updated = await transition(tx, chargeback, [from], { status: "WRITTEN_OFF" });
  if (!updated) throw new ConflictError({ message: "The chargeback changed meanwhile; reload it.", retryable: true });
  const now = new Date();
  const adjustmentKey = chargebackWriteOffAdjustmentKey(chargeback.id);
  await tx.adjustment.createMany({
    data: [
      {
        tenantId: chargeback.tenantId,
        jobId: job.id,
        customerId: job.customerId,
        amountMinor: -chargeback.amountMinor,
        currency: chargeback.currency,
        reasonCode: CHARGEBACK_WRITE_OFF_REASON_CODE,
        reason,
        status: "APPROVED",
        decidedAt: now,
        approvalRequestId,
        orgUnitId: job.orgUnitId,
        idempotencyKey: adjustmentKey,
        requestedById,
      },
    ],
    skipDuplicates: true,
  });
  const adjustment = await tx.adjustment.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId: chargeback.tenantId, idempotencyKey: adjustmentKey } } });
  const posted = await postApprovedAdjustmentInTx(tx, ctx, adjustment, job, ledgerActor);
  await auditStatus(tx, ctx, "chargeback.written_off", chargeback, updated, { adjustmentId: posted.id, approvalRequestId }, reason);
  return updated;
}

/**
 * `POST /finance/chargebacks/{id}/write-off`: asks to write a LOST chargeback off (reason required). With a
 * CHARGEBACK_WRITE_OFF policy for the amount: WRITE_OFF_PENDING_APPROVAL and an approval request that neither the
 * requester nor the person who recorded the chargeback can decide; without one: written off at once.
 */
export async function requestChargebackWriteOff(actor: Actor, ctx: RequestContext, chargebackId: string, input: ReasonInput): Promise<{ chargeback: ChargebackView; approvalRequired: boolean; approvalRequestId: string | null }> {
  const result = await withTenant(actor.tenantId, async (tx) => {
    const { chargeback } = await loadForEdit(tx, actor, chargebackId);
    if (chargeback.status === "WRITE_OFF_PENDING_APPROVAL" || chargeback.status === "WRITTEN_OFF") {
      return { chargeback, approvalRequestId: chargeback.status === "WRITE_OFF_PENDING_APPROVAL" ? chargeback.writeOffApprovalRequestId : null, notificationIds: [] as string[] };
    }
    if (chargeback.status !== "LOST") throw invalid(chargeback, "WRITE_OFF_PENDING_APPROVAL");
    // Every earlier write-off request of this chargeback (rejected or expired) gets its own key: a new attempt never collides.
    const earlier = await tx.approvalRequest.count({ where: { tenantId: actor.tenantId, subjectType: CHARGEBACK_WRITE_OFF_SUBJECT, subjectId: chargeback.id } });
    const approval = await createApprovalRequestInTx(tx, ctx, {
      tenantId: actor.tenantId,
      subjectType: CHARGEBACK_WRITE_OFF_SUBJECT,
      subjectId: chargeback.id,
      amount: { amountMinor: chargeback.amountMinor, currency: chargeback.currency },
      jobId: chargeback.jobId,
      customerId: chargeback.customerId,
      reason: input.reason,
      details: { chargebackId: chargeback.id, paymentId: chargeback.paymentId, amountMinor: chargeback.amountMinor, currency: chargeback.currency },
      // §21.3: whoever recorded the chargeback is an editor of the subject and never decides its write-off.
      excludedApproverIds: chargeback.recordedById ? [chargeback.recordedById] : [],
      idempotencyKey: correctionApprovalKeys.chargebackWriteOff(chargeback.id, earlier + 1),
    });
    if (!approval.required) {
      const written = await writeOffInTx(tx, ctx, chargeback, "LOST", input.reason, actor.userId, null, { userId: actor.userId });
      return { chargeback: written, approvalRequestId: null, notificationIds: [] as string[] };
    }
    const pending = await transition(tx, chargeback, ["LOST"], { status: "WRITE_OFF_PENDING_APPROVAL", writeOffApprovalRequestId: approval.request.id });
    if (!pending) throw new ConflictError({ message: "The chargeback changed meanwhile; reload it.", retryable: true });
    await auditStatus(tx, ctx, "chargeback.write_off_request", chargeback, pending, { approvalRequestId: approval.request.id }, input.reason);
    return { chargeback: pending, approvalRequestId: approval.request.id, notificationIds: approval.notificationIds };
  });
  await deliverAfterCommit(actor.tenantId, result.notificationIds);
  return { chargeback: toChargebackView(result.chargeback), approvalRequired: result.approvalRequestId !== null, approvalRequestId: result.approvalRequestId };
}

/** Approval callback: the write-off was approved -> WRITTEN_OFF + the posted system adjustment. */
export async function onWriteOffApproved(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const chargeback = await tx.chargeback.findFirst({ where: { id: event.subjectId, tenantId: event.tenantId } });
  if (!chargeback || chargeback.status !== "WRITE_OFF_PENDING_APPROVAL" || chargeback.writeOffApprovalRequestId !== event.requestId) return;
  // The requester and their reason are the approval request's (the engine's record of who asked and why).
  const request = await tx.approvalRequest.findFirstOrThrow({ where: { id: event.requestId, tenantId: event.tenantId }, select: { requestedById: true, reason: true } });
  await writeOffInTx(tx, event.ctx, chargeback, "WRITE_OFF_PENDING_APPROVAL", request.reason ?? "Chargeback written off", request.requestedById, event.requestId, ledgerActorOf(event.ctx));
}

/** Approval callback: rejected, expired or cancelled -> back to LOST (a new write-off may be requested later). */
export async function onWriteOffRejected(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const chargeback = await tx.chargeback.findFirst({ where: { id: event.subjectId, tenantId: event.tenantId } });
  if (!chargeback || chargeback.status !== "WRITE_OFF_PENDING_APPROVAL" || chargeback.writeOffApprovalRequestId !== event.requestId) return;
  const updated = await transition(tx, chargeback, ["WRITE_OFF_PENDING_APPROVAL"], { status: "LOST" });
  if (updated) await auditStatus(tx, event.ctx, "chargeback.write_off_rejected", chargeback, updated, { approvalRequestId: event.requestId, outcome: event.outcome }, event.reason);
}

/** The scope of a chargeback (its job's current unit); null when missing. */
export async function chargebackResourceRef(tx: TenantTx, tenantId: string, chargebackId: string): Promise<ResourceRef | null> {
  const chargeback = await tx.chargeback.findFirst({ where: { id: chargebackId, tenantId }, select: { job: { select: { orgUnitId: true } } } });
  return chargeback ? financeJobRef(chargeback.job) : null;
}

/** `GET /finance/chargebacks`: chargebacks in the caller's scope (through the job), newest first (`openedAt desc, id desc`). */
export async function listChargebacks(actor: Actor, query: ListChargebacksQuery): Promise<Page<ChargebackView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_chargebacks.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_chargebacks.view", now);
    const filters: Prisma.ChargebackWhereInput[] = [];
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.paymentId) filters.push({ paymentId: query.paymentId });
    if (query.status) filters.push({ status: query.status });
    const rows = await tx.chargeback.findMany({
      where: withinScope<Prisma.ChargebackWhereInput>({ job: buildScopeWhere(scope, financeJobScopeColumns, now) }, { tenantId: actor.tenantId, AND: filters }),
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toChargebackView), page: page.page };
  });
}

/** `GET /finance/chargebacks/{id}` (outside the caller's scope = 404). */
export async function getChargeback(actor: Actor, chargebackId: string): Promise<ChargebackView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_chargebacks.view");
    const chargeback = await tx.chargeback.findFirst({ where: { id: chargebackId, tenantId: actor.tenantId } });
    if (!chargeback) throw new NotFoundError();
    const job = await requireFinanceJob(tx, actor.tenantId, chargeback.jobId);
    await enforceInTx(tx, actor, "finance_chargebacks.view", financeJobRef(job));
    return toChargebackView(chargeback);
  });
}
