import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as reverseRoute } from "@/app/api/v1/finance/ledger/entries/[id]/reverse/route";
import { GET as jobBalanceRoute } from "@/app/api/v1/finance/jobs/[id]/balance/route";
import { POST as failRoute } from "@/app/api/v1/finance/payments/[id]/fail/route";
import { POST as receiveRoute } from "@/app/api/v1/finance/payments/[id]/receive/route";
import { GET as getPaymentRoute } from "@/app/api/v1/finance/payments/[id]/route";
import { POST as voidRoute } from "@/app/api/v1/finance/payments/[id]/void/route";
import { GET as listPaymentsRoute, POST as recordRoute } from "@/app/api/v1/finance/payments/route";
import { disconnect } from "../authz/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildFinanceWorld, idempotencyHeader, ledgerOf, makeJob, type FinanceWorld } from "./fixtures";

let w: FinanceWorld;

beforeAll(async () => {
  w = await buildFinanceWorld("payments");
});
afterAll(disconnect);

const record = (body: Record<string, unknown>, key: string | null = randomUUID(), cookie = w.cookie.finance) =>
  call(recordRoute, "POST", "/api/v1/finance/payments", { cookie, body, headers: key ? idempotencyHeader(key) : {} });
const balance = async (jobId: string, cookie = w.cookie.finance) => call(jobBalanceRoute, "GET", "/x", { cookie, params: { id: jobId } });

describe("manual payments (cash / check / card terminal)", () => {
  it("records a received payment, posts ONE PAYMENT entry and audits it", async () => {
    const job = await makeJob(w);
    const response = await record({ jobId: job.id, method: "CHECK", amountMinor: 12_500, reference: "CHK-1001" });
    expect(response.status).toBe(201);
    expect(response.json.data).toMatchObject({ replayed: false, payment: { jobId: job.id, method: "CHECK", status: "RECEIVED", origin: "MANUAL", amountMinor: "12500", reference: "CHK-1001", recordedById: w.finance.userId } });
    expect(response.json.data.payment.idempotencyKey).toBeUndefined();
    const entries = await ledgerOf(w, job.id);
    expect(entries).toMatchObject([{ type: "PAYMENT", amountMinor: 12_500n, paymentId: response.json.data.payment.id, actorUserId: w.finance.userId }]);
    expect(await auditEvents(w.tenantId, "payment.record", response.json.data.payment.id)).toHaveLength(1);
  });

  it("requires an Idempotency-Key and a reference for checks and card-terminal payments", async () => {
    const job = await makeJob(w);
    expect((await record({ jobId: job.id, method: "CASH", amountMinor: 100 }, null)).json.error.details[0].code).toBe("payment.idempotency_key_required");
    expect((await record({ jobId: job.id, method: "CARD", amountMinor: 100 })).status).toBe(400);
    expect((await record({ jobId: job.id, method: "CASH", amountMinor: 0 })).status).toBe(400);
    expect((await record({ jobId: job.id, method: "CASH", amountMinor: "12.50" })).status).toBe(400);
    expect((await record({ jobId: job.id, method: "CASH", amountMinor: 100, currency: "EUR" })).json.error.details[0].code).toBe("payment.currency_mismatch");
    expect(await ledgerOf(w, job.id)).toHaveLength(0);
  });

  it("a retry with the same key replays; concurrent duplicates create one payment and one entry", async () => {
    const job = await makeJob(w);
    const key = randomUUID();
    const body = { jobId: job.id, method: "CASH", amountMinor: 3_000 };
    const first = await record(body, key);
    const retry = await record(body, key);
    // The request idempotency store replays the first response verbatim (status 201, header Idempotent-Replayed).
    expect(retry.status).toBe(201);
    expect(retry.json.data.payment.id).toBe(first.json.data.payment.id);

    const job2 = await makeJob(w);
    const key2 = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => record({ ...body, jobId: job2.id }, key2)));
    // The request store answers in-flight duplicates 409 (retryable); every success names the same payment.
    const ok = results.filter((r) => r.status === 200 || r.status === 201);
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((r) => r.json.data.payment.id)).size).toBe(1);
    for (const r of results.filter((r) => r.status === 409)) expect(r.json.error.retryable).toBe(true);
    expect(await ledgerOf(w, job2.id)).toHaveLength(1);
  });

  it("derives the payment status per job: unpaid, partial, paid, overpaid", async () => {
    const job = await makeJob(w);
    expect((await balance(job.id)).json.data.balances).toEqual([]);
    // A charge comes from finance confirming an outcome (revenue.test.ts); here payments alone: no charge = OVERPAID.
    await record({ jobId: job.id, method: "CASH", amountMinor: 1_000 });
    expect((await balance(job.id)).json.data.balances[0]).toMatchObject({ currency: "USD", collectedMinor: "1000", outstandingMinor: "-1000", paymentStatus: "OVERPAID" });
  });
});

describe("payment status changes", () => {
  it("PENDING -> RECEIVED posts the entry once; RECEIVED -> VOIDED reverses it", async () => {
    const job = await makeJob(w);
    const created = await record({ jobId: job.id, method: "CHECK", amountMinor: 8_000, reference: "CHK-77", status: "PENDING" });
    const paymentId = created.json.data.payment.id as string;
    expect(await ledgerOf(w, job.id)).toHaveLength(0);

    const received = await call(receiveRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: paymentId }, body: {} });
    expect(received.json.data).toMatchObject({ replayed: false, payment: { status: "RECEIVED" } });
    const again = await call(receiveRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: paymentId }, body: {} });
    expect(again.json.data.replayed).toBe(true);
    expect(await ledgerOf(w, job.id)).toHaveLength(1);

    const voided = await call(voidRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: paymentId }, body: { reason: "Check bounced after deposit" } });
    expect(voided.json.data.payment).toMatchObject({ status: "VOIDED", voidReason: "Check bounced after deposit" });
    const entries = await ledgerOf(w, job.id);
    expect(entries.map((e) => [e.type, e.amountMinor])).toEqual([
      ["PAYMENT", 8_000n],
      ["REVERSAL", -8_000n],
    ]);
    expect((await balance(job.id)).json.data.balances[0]).toMatchObject({ collectedMinor: "0", paymentStatus: "NOT_CHARGED" });
    const [audit] = await auditEvents(w.tenantId, "payment.void", paymentId);
    expect(audit).toMatchObject({ reason: "Check bounced after deposit", previousValue: { status: "RECEIVED" }, newValue: { status: "VOIDED" } });

    // Voiding again is a replay; a voided payment cannot come back.
    expect((await call(voidRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: paymentId }, body: { reason: "again" } })).json.data.replayed).toBe(true);
    expect((await call(receiveRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: paymentId }, body: {} })).json.error.code).toBe("INVALID_STATE_TRANSITION");
    expect(await ledgerOf(w, job.id)).toHaveLength(2);
  });

  it("PENDING -> FAILED needs a reason and posts nothing; concurrent voids post one reversal", async () => {
    const job = await makeJob(w);
    const pending = (await record({ jobId: job.id, method: "CASH", amountMinor: 500, status: "PENDING" })).json.data.payment.id as string;
    expect((await call(failRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: pending }, body: {} })).status).toBe(400);
    const failed = await call(failRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: pending }, body: { reason: "Customer did not pay" } });
    expect(failed.json.data.payment).toMatchObject({ status: "FAILED", failureReason: "Customer did not pay" });
    expect(await ledgerOf(w, job.id)).toHaveLength(0);

    const received = (await record({ jobId: job.id, method: "CASH", amountMinor: 900 })).json.data.payment.id as string;
    const voids = await Promise.all(Array.from({ length: 5 }, () => call(voidRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: received }, body: { reason: "Recorded twice" } })));
    expect(voids.every((r) => r.status === 200)).toBe(true);
    expect(voids.filter((r) => r.json.data.replayed === false)).toHaveLength(1);
    expect((await ledgerOf(w, job.id)).filter((e) => e.type === "REVERSAL")).toHaveLength(1);
  });

  it("the generic reversal only takes charges: a payment entry must be voided through its payment", async () => {
    const job = await makeJob(w);
    await record({ jobId: job.id, method: "CASH", amountMinor: 400 });
    const [entry] = await ledgerOf(w, job.id);
    const response = await call(reverseRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: entry.id }, body: { reason: "wrong" } });
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("ledger.reverse_not_supported");
  });

  it("lists and reads payments", async () => {
    const job = await makeJob(w);
    const id = (await record({ jobId: job.id, method: "CASH", amountMinor: 250 })).json.data.payment.id as string;
    const list = await call(listPaymentsRoute, "GET", "/x", { cookie: w.cookie.finance, query: { jobId: job.id } });
    expect(list.json.data.map((p: { id: string }) => p.id)).toEqual([id]);
    expect((await call(getPaymentRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id } })).json.data).toMatchObject({ id, amountMinor: "250" });
  });
});
