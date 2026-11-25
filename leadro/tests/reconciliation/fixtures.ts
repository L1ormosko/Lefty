import { createHash, randomUUID } from "node:crypto";
import { POST as chargeRoute } from "@/app/api/v1/finance/outcomes/[id]/charge/route";
import { POST as failRoute } from "@/app/api/v1/finance/payments/[id]/fail/route";
import { POST as recordRoute } from "@/app/api/v1/finance/payments/route";
import { GET as listExceptionsRoute } from "@/app/api/v1/finance/reconciliation/exceptions/route";
import { POST as startRunRoute } from "@/app/api/v1/finance/reconciliation/runs/route";
import { withTenant } from "@/server/db";
import { call } from "../org/org-helpers";
import { idempotencyHeader, type FinanceWorld } from "../finance/fixtures";

/**
 * Reconciliation test helpers. Money is moved through the real finance API (charge confirmation, payments); records the
 * parallel Task 5 module owns (refunds) and provider events are inserted straight into the database, as their own services
 * would have stored them.
 */

const DAY = 86_400_000;

/** A period around "now" that contains everything the helpers create (outcomes are stored 1 hour ago). */
export const currentPeriod = () => ({ periodStart: new Date(Date.now() - 2 * DAY).toISOString(), periodEnd: new Date(Date.now() + DAY).toISOString() });

export const confirmCharge = (w: FinanceWorld, outcomeId: string, expectedAmountMinor: number) =>
  call(chargeRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: outcomeId }, body: { expectedAmountMinor } });

export async function recordPayment(w: FinanceWorld, jobId: string, amountMinor: number, status: "RECEIVED" | "PENDING" = "RECEIVED"): Promise<string> {
  const response = await call(recordRoute, "POST", "/x", { cookie: w.cookie.finance, body: { jobId, method: "CASH", amountMinor, status }, headers: idempotencyHeader() });
  if (response.status !== 201) throw new Error(`payment not recorded: ${response.status} ${JSON.stringify(response.json)}`);
  return response.json.data.payment.id as string;
}

export const failPayment = (w: FinanceWorld, paymentId: string) =>
  call(failRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: paymentId }, body: { reason: "check bounced" } });

export function startRun(w: FinanceWorld, body: Record<string, unknown> = {}, cookie = w.cookie.finance) {
  return call(startRunRoute, "POST", "/x", { cookie, body: { legalEntityId: w.legalEntityId, currency: "USD", ...currentPeriod(), ...body } });
}

/** Every exception of a job visible to the caller (all statuses). */
export async function exceptionsOfJob(w: FinanceWorld, jobId: string, cookie = w.cookie.finance): Promise<Array<Record<string, unknown>>> {
  return (await call(listExceptionsRoute, "GET", "/x", { cookie, query: { jobId, limit: "100" } })).json.data;
}

/** A refund as the refunds module would have stored it (requested, not yet posted). */
export async function storeRefund(w: FinanceWorld, jobId: string, amountMinor: bigint, paymentId: string | null = null): Promise<string> {
  return withTenant(w.tenantId, async (tx) => {
    const refund = await tx.refund.create({ data: { tenantId: w.tenantId, jobId, paymentId, amountMinor, currency: "USD", reason: "customer complaint" } });
    return refund.id;
  });
}

/** A provider event the intake classified (DUPLICATE of an earlier event, or UNMATCHED). */
export async function storeIntakeEvent(
  w: FinanceWorld,
  data: { status: "DUPLICATE" | "UNMATCHED"; jobId?: string | null; amountMinor?: bigint; duplicateOfId?: string; currency?: string | null },
): Promise<string> {
  return withTenant(w.tenantId, async (tx) => {
    const externalId = `evt_${randomUUID()}`;
    const event = await tx.paymentIntakeEvent.create({
      data: {
        tenantId: w.tenantId,
        provider: "testpay",
        externalId,
        eventType: "payment.received",
        payloadHash: createHash("sha256").update(externalId).digest("hex"),
        signatureValid: true,
        status: data.status,
        rejectionCode: data.status === "UNMATCHED" ? "unknown_job" : "duplicate_provider_ref",
        jobId: data.jobId ?? null,
        amountMinor: data.amountMinor ?? 4_500n,
        currency: data.currency === undefined ? "USD" : data.currency,
        duplicateOfId: data.duplicateOfId,
        processedAt: new Date(),
      },
    });
    return event.id;
  });
}
