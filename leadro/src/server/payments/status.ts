import type { Payment, PaymentRecordStatus } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { InvalidStateTransitionError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { financeJobRef, ledgerKeys, reverseLedgerEntryInTx, type FinanceJob } from "@/server/ledger";
import type { MarkReceivedInput, ReasonInput } from "./schemas";
import { loadPaymentWithJob, postPaymentReceivedInTx, toPaymentView, type PaymentView } from "./store";

/**
 * Payment status changes (`finance_payments.edit` over the payment's job). The machine is the database's
 * (`payment_status` trigger): PENDING -> RECEIVED | FAILED | VOIDED, RECEIVED -> VOIDED. Every change is audited with the
 * previous and new status (the audit trail is the status history of finance records, docs/DECISIONS.md Phase 4 Task 1).
 *
 * Concurrency: the update is conditional on the expected current status, so two people acting at once change the record
 * once; the second sees the target status already reached and gets a replay, never a second ledger posting.
 */

type Change = { replayed: boolean; payment: PaymentView };

function invalid(payment: Payment, target: PaymentRecordStatus): InvalidStateTransitionError {
  const message = `A ${payment.status} payment cannot become ${target}.`;
  return new InvalidStateTransitionError({ message, details: [{ field: "status", code: "payment.invalid_transition", message }] });
}

/** Loads and authorizes; shared first step of every change. */
async function loadForChange(tx: TenantTx, actor: Actor, paymentId: string): Promise<{ payment: Payment; job: FinanceJob }> {
  await enforceInTx(tx, actor, "finance_payments.edit");
  const loaded = await loadPaymentWithJob(tx, actor.tenantId, paymentId);
  await enforceInTx(tx, actor, "finance_payments.edit", financeJobRef(loaded.job));
  return loaded;
}

/** Moves the payment from one of `from` to `to`; returns null when someone else changed it first. */
async function transition(tx: TenantTx, payment: Payment, from: PaymentRecordStatus[], data: Partial<Payment> & { status: PaymentRecordStatus }): Promise<Payment | null> {
  const { count } = await tx.payment.updateMany({ where: { id: payment.id, tenantId: payment.tenantId, status: { in: from } }, data });
  return count === 1 ? tx.payment.findFirstOrThrow({ where: { id: payment.id, tenantId: payment.tenantId } }) : null;
}

async function audit(tx: TenantTx, ctx: RequestContext, action: string, before: Payment, after: Payment, reason?: string): Promise<void> {
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action,
    targetType: "Payment",
    targetId: after.id,
    previousValue: { status: before.status },
    newValue: { status: after.status, jobId: after.jobId, amountMinor: after.amountMinor.toString(), currency: after.currency },
    reason,
  });
}

/** A PENDING payment arrived (a check cleared): RECEIVED + the PAYMENT ledger entry. */
export async function markPaymentReceived(actor: Actor, ctx: RequestContext, paymentId: string, input: MarkReceivedInput): Promise<Change> {
  const receivedAt = input.receivedAt ?? new Date();
  if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw new ValidationError({ message: "A payment cannot be received in the future.", field: "body.receivedAt" });
  return withTenant(actor.tenantId, async (tx) => {
    const { payment, job } = await loadForChange(tx, actor, paymentId);
    if (payment.status === "RECEIVED") return { replayed: true, payment: toPaymentView(payment) };
    if (payment.status !== "PENDING") throw invalid(payment, "RECEIVED");
    const updated = await transition(tx, payment, ["PENDING"], { status: "RECEIVED", receivedAt });
    if (!updated) return settleRace(tx, payment, "RECEIVED");
    await postPaymentReceivedInTx(tx, updated, job, { userId: actor.userId });
    await audit(tx, ctx, "payment.receive", payment, updated);
    return { replayed: false, payment: toPaymentView(updated) };
  });
}

/** A PENDING payment did not arrive (bounced check, declined card). Nothing was posted, so nothing is reversed. */
export async function markPaymentFailed(actor: Actor, ctx: RequestContext, paymentId: string, input: ReasonInput): Promise<Change> {
  return withTenant(actor.tenantId, async (tx) => {
    const { payment } = await loadForChange(tx, actor, paymentId);
    if (payment.status === "FAILED") return { replayed: true, payment: toPaymentView(payment) };
    if (payment.status !== "PENDING") throw invalid(payment, "FAILED");
    const updated = await transition(tx, payment, ["PENDING"], { status: "FAILED", failedAt: new Date(), failureReason: input.reason });
    if (!updated) return settleRace(tx, payment, "FAILED");
    await audit(tx, ctx, "payment.fail", payment, updated, input.reason);
    return { replayed: false, payment: toPaymentView(updated) };
  });
}

/**
 * Voids a payment recorded by mistake (or one received and then found invalid). A RECEIVED payment's PAYMENT entry is
 * REVERSED (never deleted or edited), so the job's collected balance drops by exactly that amount.
 */
export async function voidPayment(actor: Actor, ctx: RequestContext, paymentId: string, input: ReasonInput): Promise<Change> {
  return withTenant(actor.tenantId, async (tx) => {
    await loadForChange(tx, actor, paymentId);
    // The same row lock refunds and chargebacks take (finance-adjustments `lockPayment`): a payout or a chargeback against
    // this payment and its void are serialized, so the check below sees every one of them.
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    const payment = await tx.payment.findFirstOrThrow({ where: { id: paymentId, tenantId: actor.tenantId } });
    if (payment.status === "VOIDED") return { replayed: true, payment: toPaymentView(payment) };
    if (payment.status !== "PENDING" && payment.status !== "RECEIVED") throw invalid(payment, "VOIDED");
    if (payment.status === "RECEIVED") await assertNoMoneyReturned(tx, payment);
    const updated = await transition(tx, payment, [payment.status], { status: "VOIDED", voidedAt: new Date(), voidReason: input.reason });
    if (!updated) return settleRace(tx, payment, "VOIDED");
    if (payment.status === "RECEIVED") {
      const posted = await tx.ledgerEntry.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: actor.tenantId, idempotencyKey: ledgerKeys.paymentReceived(payment.id) } },
        select: { id: true },
      });
      // Every RECEIVED payment was posted in the transaction that received it; a missing entry would be a broken invariant.
      if (!posted) throw new Error(`payment ${payment.id} is RECEIVED without its ledger entry`);
      await reverseLedgerEntryInTx(tx, {
        tenantId: actor.tenantId,
        entryId: posted.id,
        actor: { userId: actor.userId },
        reason: input.reason,
        idempotencyKey: ledgerKeys.paymentVoided(payment.id),
      });
    }
    await audit(tx, ctx, "payment.void", payment, updated, input.reason);
    return { replayed: false, payment: toPaymentView(updated) };
  });
}

/**
 * Refuses to void a RECEIVED payment part of whose money already left again: a POSTED refund (paid back) or a chargeback
 * that was not WON (debited by the processor). Voiding would reverse the whole PAYMENT entry while the REFUND / CHARGEBACK
 * entries stay, so the money would count as gone twice (net collected below zero). Refunds not paid out yet do not block:
 * their payout is refused once the payment is voided (`refund.payment_not_received`). Review P4-R1.
 */
async function assertNoMoneyReturned(tx: TenantTx, payment: Payment): Promise<void> {
  const where = { tenantId: payment.tenantId, paymentId: payment.id };
  const posted = await tx.refund.count({ where: { ...where, status: "POSTED" } });
  const charged = await tx.chargeback.count({ where: { ...where, status: { not: "WON" } } });
  if (posted + charged === 0) return;
  const message = "Part of this payment was already refunded or charged back; it cannot be voided. Correct it with an adjustment instead.";
  throw new InvalidStateTransitionError({ message, details: [{ field: "paymentId", code: "payment.money_returned", message }] });
}

/** The conditional update lost a race: a replay if the other request reached the same status, else the transition is invalid. */
async function settleRace(tx: TenantTx, payment: Payment, target: PaymentRecordStatus): Promise<Change> {
  const current = await tx.payment.findFirstOrThrow({ where: { id: payment.id, tenantId: payment.tenantId } });
  if (current.status === target) return { replayed: true, payment: toPaymentView(current) };
  throw invalid(current, target);
}
