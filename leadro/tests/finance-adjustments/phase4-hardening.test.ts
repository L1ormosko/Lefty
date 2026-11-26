import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as jobBalanceRoute } from "@/app/api/v1/finance/jobs/[id]/balance/route";
import { POST as voidRoute } from "@/app/api/v1/finance/payments/[id]/void/route";
import { POST as chargebackRoute } from "@/app/api/v1/finance/chargebacks/route";
import { POST as reverseRoute } from "@/app/api/v1/finance/ledger/entries/[id]/reverse/route";
import { POST as chargeRoute } from "@/app/api/v1/finance/outcomes/[id]/charge/route";
import { GET as flagsRoute } from "@/app/api/v1/finance/review-flags/route";
import { POST as completeRoute } from "@/app/api/v1/finance/refunds/[id]/complete/route";
import { POST as paymentsRoute } from "@/app/api/v1/finance/payments/route";
import { POST as requestRoute } from "@/app/api/v1/finance/refunds/route";
import { disconnect } from "../authz/fixtures";
import { ledgerOf, makeJob, storeSoldOutcome } from "../finance/fixtures";
import { call } from "../org/org-helpers";
import { buildCorrectionsWorld, flagsOf, idempotencyHeader, receivedPayment, type CorrectionsWorld } from "./fixtures";

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

describe("P4-R2: a single-person correction that takes money out of the books is flagged for a second person", () => {
  it("reversing a CHARGE raises one ledger.charge_reversed flag (a replay raises none), visible to the unit's manager", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 12_000n });
    const charged = await call(chargeRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: outcomeId }, body: { expectedAmountMinor: 12_000 } });
    const entryId = charged.json.data.entryId as string;
    const reverse = () => call(reverseRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: entryId }, body: { reason: "Charged the wrong job" } });
    const first = await reverse();
    expect(first.status).toBe(201);
    expect((await reverse()).status).toBe(200);

    const flags = await flagsOf(w, job.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      reasonCode: "ledger.charge_reversed",
      status: "OPEN",
      systemActor: "system:finance-review",
      raisedById: null,
      outcomeId,
      ledgerEntryId: first.json.data.reversal.id,
      orgUnitId: w.units.cityA,
    });
    expect(flags[0].details).toMatchObject({ originalEntryId: entryId, amountMinor: "12000", currency: "USD", correctedById: w.finance.userId });
    const listed = await call(flagsRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, query: { jobId: job.id } });
    expect(listed.json.data.map((flag: { reasonCode: string }) => flag.reasonCode)).toEqual(["ledger.charge_reversed"]);
  });

  it("voiding a RECEIVED payment raises one payment.voided_after_receipt flag; voiding a PENDING one raises none", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 50_000);
    expect((await voidPayment(paymentId)).status).toBe(200);
    expect((await voidPayment(paymentId)).json.data.replayed).toBe(true);
    const flags = await flagsOf(w, job.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ reasonCode: "payment.voided_after_receipt", paymentId, systemActor: "system:finance-review" });
    const reversal = (await ledgerOf(w, job.id)).find((entry) => entry.type === "REVERSAL");
    expect(flags[0].ledgerEntryId).toBe(reversal?.id);

    const pendingJob = await makeJob(w);
    const pending = await call(paymentsRoute, "POST", "/x", {
      cookie: w.cookie.finance,
      body: { jobId: pendingJob.id, method: "CHECK", amountMinor: 4_000, status: "PENDING", reference: "CHK-1" },
      headers: idempotencyHeader(),
    });
    expect(pending.status).toBe(201);
    expect((await voidPayment(pending.json.data.payment.id)).status).toBe(200);
    expect(await flagsOf(w, pendingJob.id)).toEqual([]);
  });
});
