import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as jobBalanceRoute } from "@/app/api/v1/finance/jobs/[id]/balance/route";
import { POST as voidRoute } from "@/app/api/v1/finance/payments/[id]/void/route";
import { POST as chargebackRoute } from "@/app/api/v1/finance/chargebacks/route";
import { POST as completeRoute } from "@/app/api/v1/finance/refunds/[id]/complete/route";
import { POST as requestRoute } from "@/app/api/v1/finance/refunds/route";
import { disconnect } from "../authz/fixtures";
import { ledgerOf, makeJob } from "../finance/fixtures";
import { call } from "../org/org-helpers";
import { buildCorrectionsWorld, idempotencyHeader, receivedPayment, type CorrectionsWorld } from "./fixtures";

/**
 * Regression tests for the Phase 4 whole-phase review (docs/reviews/phase4-review.md). Each block names its finding.
 */

let w: CorrectionsWorld;

beforeAll(async () => {
  // No REFUND policy: refunds are approved at once, so the tests reach the payout directly.
  w = await buildCorrectionsWorld("p4-hardening");
});
afterAll(disconnect);

const voidPayment = (paymentId: string, cookie = w.cookie.finance) =>
  call(voidRoute, "POST", "/x", { cookie, params: { id: paymentId }, body: { reason: "Recorded by mistake" } });
const balance = async (jobId: string) => (await call(jobBalanceRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobId } })).json.data.balances[0];

async function postedRefund(paymentId: string, amountMinor: number): Promise<string> {
  const requested = await call(requestRoute, "POST", "/x", { cookie: w.cookie.finance, body: { paymentId, amountMinor, reason: "Partial refund" }, headers: idempotencyHeader() });
  const refundId = requested.json.data.refund.id as string;
  const paid = await call(completeRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: refundId }, body: {} });
  expect(paid.json.data.refund.status).toBe("POSTED");
  return refundId;
}

describe("P4-R1: a payment whose money already went back out cannot be voided", () => {
  it("refuses to void a RECEIVED payment with a POSTED refund (the refund would be counted twice)", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 10_000);
    await postedRefund(paymentId, 3_000);

    const response = await voidPayment(paymentId);
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("payment.money_returned");
    // Nothing was reversed: collected 100.00, refunded 30.00, net 70.00 (never -30.00).
    expect((await ledgerOf(w, job.id)).map((e) => e.type)).toEqual(["PAYMENT", "REFUND"]);
    expect(await balance(job.id)).toMatchObject({ collectedMinor: "10000", refundedMinor: "3000", netCollectedMinor: "7000" });
  });

  it("refuses to void a RECEIVED payment with an open chargeback (its money is already debited)", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 8_000);
    const charged = await call(chargebackRoute, "POST", "/x", { cookie: w.cookie.finance, body: { paymentId, amountMinor: 8_000 }, headers: idempotencyHeader() });
    expect(charged.status).toBe(201);

    const response = await voidPayment(paymentId);
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("payment.money_returned");
    expect((await ledgerOf(w, job.id)).map((e) => e.type)).toEqual(["PAYMENT", "CHARGEBACK"]);
  });

  it("a refund paid out while a void is in flight never ends with both (payment row lock)", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 6_000);
    const requested = await call(requestRoute, "POST", "/x", { cookie: w.cookie.finance, body: { paymentId, amountMinor: 2_000, reason: "Race" }, headers: idempotencyHeader(randomUUID()) });
    const refundId = requested.json.data.refund.id as string;
    const [paid, voided] = await Promise.all([
      call(completeRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: refundId }, body: {} }),
      voidPayment(paymentId),
    ]);
    // Exactly one of them wins; the ledger never holds the REFUND and the payment's REVERSAL together.
    expect([paid.status, voided.status].filter((status) => status === 200)).toHaveLength(1);
    const types = (await ledgerOf(w, job.id)).map((e) => e.type).sort();
    expect([["PAYMENT", "REFUND"], ["PAYMENT", "REVERSAL"]]).toContainEqual(types);
  });
});
