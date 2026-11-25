import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { financeJobRef, loadFinanceJob, paymentKeys } from "@/server/ledger";
import type { RecordPaymentInput } from "./schemas";
import { createPaymentIdempotently, postPaymentReceivedInTx, toPaymentView, type PaymentView } from "./store";

/** A device clock a little ahead is tolerated; a receipt further in the future is a typo. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * Records a payment by hand (spec 11.1: cash, check, card terminal, bank transfer...), `finance_payments.create` over the
 * job. The `Idempotency-Key` the client sent is REQUIRED and becomes the record's key (scoped to the recording user), so a
 * double submit, a retry after a timeout, or two concurrent identical requests create ONE payment and ONE ledger entry.
 * RECEIVED posts the PAYMENT entry in the same transaction; PENDING posts nothing until it is marked received.
 */
export async function recordManualPayment(
  actor: Actor,
  ctx: RequestContext,
  input: RecordPaymentInput,
  clientKey: string | null,
): Promise<{ payment: PaymentView; replayed: boolean }> {
  if (!clientKey) {
    throw new ValidationError({
      message: "Recording a payment needs an Idempotency-Key header.",
      field: "Idempotency-Key",
      details: [{ field: "Idempotency-Key", code: "payment.idempotency_key_required", message: "Recording a payment needs an Idempotency-Key header." }],
    });
  }
  const now = new Date();
  if (input.receivedAt && input.receivedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new ValidationError({ message: "A payment cannot be received in the future.", field: "body.receivedAt" });
  }

  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_payments.create");
    const job = await loadFinanceJob(tx, actor.tenantId, input.jobId);
    if (!job) throw new NotFoundError();
    await enforceInTx(tx, actor, "finance_payments.create", financeJobRef(job));
    const currency = input.currency ?? job.currency;
    if (currency !== job.currency) {
      throw new ValidationError({
        message: "A payment must be in the job's currency.",
        field: "body.currency",
        details: [{ field: "body.currency", code: "payment.currency_mismatch", message: "A payment must be in the job's currency." }],
      });
    }

    const received = input.status === "RECEIVED";
    const { payment, replayed } = await createPaymentIdempotently(tx, actor.tenantId, job, paymentKeys.manual(actor.userId, clientKey), {
      origin: "MANUAL",
      method: input.method,
      status: input.status,
      amountMinor: input.amountMinor,
      currency,
      reference: input.reference ?? null,
      receivedAt: received ? (input.receivedAt ?? now) : null,
      recordedById: actor.userId,
    });
    if (replayed) return { payment: toPaymentView(payment), replayed };

    if (received) await postPaymentReceivedInTx(tx, payment, job, { userId: actor.userId });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "payment.record",
      targetType: "Payment",
      targetId: payment.id,
      newValue: { jobId: job.id, method: payment.method, status: payment.status, amountMinor: payment.amountMinor.toString(), currency, hasReference: payment.reference !== null },
    });
    return { payment: toPaymentView(payment), replayed };
  });
}
