import type { Payment, PaymentOrigin, Prisma } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { ledgerKeys, loadFinanceJob, postLedgerEntryInTx, type FinanceJob, type LedgerActor, type PostResult } from "@/server/ledger";

/**
 * Shared persistence of payment records. A payment record says what happened (method, amount, reference, status); the
 * MONEY is the PAYMENT ledger entry posted when the record becomes RECEIVED (spec 11.8), never the record itself.
 */

/** What a payment looks like in API responses: everything but the tenant and the internal idempotency key. */
export type PaymentView = Omit<Payment, "tenantId" | "idempotencyKey">;

export function toPaymentView(payment: Payment): PaymentView {
  const { tenantId: _tenantId, idempotencyKey: _key, ...view } = payment;
  return view;
}

export type NewPayment = Omit<Prisma.PaymentCreateManyInput, "tenantId" | "idempotencyKey" | "jobId" | "customerId" | "orgUnitId" | "currency"> & {
  currency: string;
  /** Always explicit: it is part of what identifies the payment on a replay. */
  origin: PaymentOrigin;
};

/** The fields that define a payment: a second create under the same key must match them, else the key was reused. */
const IDENTITY_FIELDS = ["jobId", "method", "amountMinor", "currency", "origin", "outcomeId", "provider", "providerRef"] as const;

/**
 * Creates a payment record unless one already exists under `idempotencyKey` (unique per tenant): `INSERT ... ON CONFLICT DO
 * NOTHING`, so a concurrent duplicate waits for the first transaction and then finds its row instead of aborting.
 * Customer and unit are copied from the job. 409 `payment.idempotency_key_reused` when the key names a different payment.
 */
export async function createPaymentIdempotently(
  tx: TenantTx,
  tenantId: string,
  job: FinanceJob,
  idempotencyKey: string,
  data: NewPayment,
): Promise<{ payment: Payment; replayed: boolean }> {
  const row: Prisma.PaymentCreateManyInput = { ...data, tenantId, jobId: job.id, customerId: job.customerId, orgUnitId: job.orgUnitId, idempotencyKey };
  const inserted = await tx.payment.createMany({ data: [row], skipDuplicates: true });
  const payment = await tx.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } } });
  // Skipped for another unique rule: (provider, providerRef). The intake checks that first, so this is a lost race.
  if (!payment) throw new ConflictError({ message: "This payment was already recorded.", retryable: true });
  const same = IDENTITY_FIELDS.every((field) => (payment[field] ?? null) === (row[field] ?? null));
  if (!same) {
    throw new ConflictError({
      message: "This idempotency key was already used for a different payment.",
      details: [{ field: "idempotencyKey", code: "payment.idempotency_key_reused", message: "This idempotency key was already used for a different payment." }],
    });
  }
  return { payment, replayed: inserted.count === 0 };
}

/** Posts the PAYMENT ledger entry of a RECEIVED payment (once per payment: key `payment:<id>:received`). */
export function postPaymentReceivedInTx(tx: TenantTx, payment: Payment, job: FinanceJob, actor: LedgerActor): Promise<PostResult> {
  return postLedgerEntryInTx(tx, {
    tenantId: payment.tenantId,
    type: "PAYMENT",
    source: "PAYMENT",
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    job,
    refs: { paymentId: payment.id, ...(payment.outcomeId ? { outcomeId: payment.outcomeId } : {}) },
    idempotencyKey: ledgerKeys.paymentReceived(payment.id),
    actor,
    // The money arrived at `receivedAt` (set with the status, DB CHECK payment_received_at).
    occurredAt: payment.receivedAt ?? new Date(),
  });
}

/** A payment and its job (for the job's unit: the payment's scope follows its job, like the job balance). 404 when missing. */
export async function loadPaymentWithJob(tx: TenantTx, tenantId: string, paymentId: string): Promise<{ payment: Payment; job: FinanceJob }> {
  const payment = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
  if (!payment) throw new NotFoundError();
  const job = await loadFinanceJob(tx, tenantId, payment.jobId);
  if (!job) throw new NotFoundError();
  return { payment, job };
}
