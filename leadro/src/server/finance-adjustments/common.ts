import type { Payment } from "@prisma/client";
import type { AuditContextFields } from "@/server/audit";
import { ConflictError, NotFoundError, ValidationError, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { loadFinanceJob, type FinanceJob, type LedgerActor } from "@/server/ledger";

/** Shared helpers of the refund, chargeback, adjustment and review-flag services. */

/** A device or office clock a little ahead is tolerated; a date further in the future is a typo. */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** The machine actor of flags and postings this module makes without a person (intake, domain reactions). */
export const FINANCE_REVIEW_SYSTEM_ACTOR = "system:finance-review";

/** Audit fields for writes that may run without a person (approval expiry, provider intake, domain reactions). */
export function auditFields(tenantId: string, ctx: RequestContext | null): AuditContextFields {
  return { tenantId, actorUserId: ctx?.actor?.userId ?? null, sourceApp: ctx?.actor ? ctx.sourceApp : "SYSTEM", correlationId: ctx?.correlationId };
}

/** The ledger actor of a write: the person of `ctx`, else the named machine actor. */
export const ledgerActorOf = (ctx: RequestContext | null, system: string = FINANCE_REVIEW_SYSTEM_ACTOR): LedgerActor =>
  ctx?.actor ? { userId: ctx.actor.userId } : { system };

/**
 * Creating a money record by hand REQUIRES the client's `Idempotency-Key`: it becomes the record's own key (scoped to the
 * user, `manual:<userId>:<key>`), so a double submit or a retry long after the 24 h request store expired still creates
 * one record (spec 20.3).
 */
export function requireClientKey(clientKey: string | null, code: string): string {
  if (!clientKey) {
    const message = "This request needs an Idempotency-Key header.";
    throw new ValidationError({ message, field: "Idempotency-Key", details: [{ field: "Idempotency-Key", code, message }] });
  }
  return clientKey;
}

export const manualRecordKey = (userId: string, clientKey: string): string => `manual:${userId}:${clientKey}`;

/** A refusal with one machine detail code (the code is also the client's i18n key). */
export function refusal(kind: "validation" | "conflict", field: string, code: string, message: string): ValidationError | ConflictError {
  const options = { message, field, details: [{ field, code, message }] };
  return kind === "validation" ? new ValidationError(options) : new ConflictError(options);
}

/** A job for finance (404 when it does not exist in the tenant). */
export async function requireFinanceJob(tx: TenantTx, tenantId: string, jobId: string): Promise<FinanceJob> {
  const job = await loadFinanceJob(tx, tenantId, jobId);
  if (!job) throw new NotFoundError();
  return job;
}

/**
 * Locks a payment row (`FOR UPDATE`) and reads it: refunds and chargebacks against the same payment queue up, so two
 * concurrent requests can never together take more than the payment holds. 404 when it does not exist.
 */
export async function lockPayment(tx: TenantTx, tenantId: string, paymentId: string): Promise<Payment> {
  await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const payment = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
  if (!payment) throw new NotFoundError();
  return payment;
}

/** Refuses a date more than a few minutes in the future (typed by a person or sent by a device). */
export function assertNotFuture(value: Date | undefined, field: string): void {
  if (value && value.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    throw new ValidationError({ message: "The date cannot be in the future.", field });
  }
}
