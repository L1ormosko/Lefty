import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as jobBalanceRoute } from "@/app/api/v1/finance/jobs/[id]/balance/route";
import { POST as voidRoute } from "@/app/api/v1/finance/payments/[id]/void/route";
import { POST as cancelRoute } from "@/app/api/v1/finance/refunds/[id]/cancel/route";
import { POST as completeRoute } from "@/app/api/v1/finance/refunds/[id]/complete/route";
import { GET as getRoute } from "@/app/api/v1/finance/refunds/[id]/route";
import { GET as listRoute, POST as requestRoute } from "@/app/api/v1/finance/refunds/route";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { ledgerOf, makeJob } from "../finance/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { addPolicy, approve, buildCorrectionsWorld, flagsOf, idempotencyHeader, receivedPayment, reject, type CorrectionsWorld } from "./fixtures";

let w: CorrectionsWorld;

beforeAll(async () => {
  w = await buildCorrectionsWorld("refunds");
  // Refunds of 100.00 and more need one approval; smaller ones need nobody (the gap below the band).
  await addPolicy(w, "REFUND", { min: 10_000 });
});
afterAll(disconnect);

const request = (body: Record<string, unknown>, cookie = w.cookie.finance, key: string | null = randomUUID()) =>
  call(requestRoute, "POST", "/api/v1/finance/refunds", { cookie, body, headers: key ? idempotencyHeader(key) : {} });
const complete = (id: string, body: Record<string, unknown> = {}, cookie = w.cookie.finance) => call(completeRoute, "POST", "/x", { cookie, params: { id }, body });
const cancel = (id: string, cookie = w.cookie.finance) => call(cancelRoute, "POST", "/x", { cookie, params: { id }, body: { reason: "Customer changed their mind" } });
const balance = async (jobId: string) => (await call(jobBalanceRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobId } })).json.data.balances[0];

/** The documented response field set of a refund (docs/API_REFERENCE.md): ids, money, status and dates; nothing operational. */
const REFUND_FIELDS = [
  "amountMinor",
  "approvalRequestId",
  "createdAt",
  "currency",
  "customerId",
  "decidedAt",
  "id",
  "jobId",
  "orgUnitId",
  "paymentId",
  "postedAt",
  "providerRef",
  "reason",
  "requestedAt",
  "requestedById",
  "status",
  "updatedAt",
];

describe("partial refund without approval (below every policy band)", () => {
  it("is APPROVED at once; paying it out posts ONE REFUND entry, raises one review flag, and replays", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 5_000);
    const response = await request({ paymentId, amountMinor: 2_000, reason: "Part of the work was not done" });
    expect(response.status).toBe(201);
    const refund = response.json.data.refund;
    expect(response.json.data).toMatchObject({ replayed: false, approvalRequired: false, approvalRequestId: null });
    expect(refund).toMatchObject({ status: "APPROVED", amountMinor: "2000", currency: "USD", jobId: job.id, paymentId, requestedById: w.finance.userId });
    expect(Object.keys(refund).sort()).toEqual(REFUND_FIELDS);
    // Approval is not money: nothing is posted until the refund is paid out.
    expect((await ledgerOf(w, job.id)).map((e) => e.type)).toEqual(["PAYMENT"]);

    const paid = await complete(refund.id, { reference: "SLIP-7" });
    expect(paid.status).toBe(200);
    expect(paid.json.data).toMatchObject({ replayed: false, refund: { status: "POSTED", providerRef: "SLIP-7" } });
    const again = await complete(refund.id);
    expect(again.json.data.replayed).toBe(true);

    const entries = await ledgerOf(w, job.id);
    expect(entries.map((e) => [e.type, e.amountMinor, e.refundId, e.paymentId])).toEqual([
      ["PAYMENT", 5_000n, null, paymentId],
      ["REFUND", -2_000n, refund.id, paymentId],
    ]);
    expect(entries[1]).toMatchObject({ source: "REFUND", idempotencyKey: `refund:${refund.id}:posted`, actorUserId: w.finance.userId });
    expect(await balance(job.id)).toMatchObject({ collectedMinor: "5000", refundedMinor: "2000", netCollectedMinor: "3000" });

    const flags = await flagsOf(w, job.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ reasonCode: "refund.posted", refundId: refund.id, systemActor: "system:finance-review", raisedById: null, status: "OPEN", orgUnitId: w.units.cityA });
    expect(await auditEvents(w.tenantId, "refund.post", refund.id)).toHaveLength(1);
  });

  it("requires an Idempotency-Key, replays the same key and refuses the key for another refund", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 5_000);
    const missing = await request({ paymentId, amountMinor: 100, reason: "x" }, w.cookie.finance, null);
    expect(missing.json.error.details[0].code).toBe("refund.idempotency_key_required");

    const key = randomUUID();
    const first = await request({ paymentId, amountMinor: 1_000, reason: "Overcharged" }, w.cookie.finance, key);
    const replay = await request({ paymentId, amountMinor: 1_000, reason: "Overcharged" }, w.cookie.finance, key);
    expect(replay.json.data.refund.id).toBe(first.json.data.refund.id);
    // A different body under the same key: the request store answers 409 (CONFLICT); the record key backs it up.
    const reused = await request({ paymentId, amountMinor: 1_500, reason: "Overcharged" }, w.cookie.finance, key);
    expect(reused.status).toBe(409);
    expect(await withTenant(w.tenantId, (tx) => tx.refund.count({ where: { paymentId } }))).toBe(1);
  });

  it("never refunds more than the payment holds, refuses another currency and a payment not received", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 5_000);
    expect((await request({ paymentId, amountMinor: 3_000, reason: "a" })).status).toBe(201);
    const over = await request({ paymentId, amountMinor: 2_500, reason: "b" });
    expect(over.status).toBe(409);
    expect(over.json.error.details[0].code).toBe("refund.exceeds_payment");
    expect((await request({ paymentId, amountMinor: 100, currency: "EUR", reason: "c" })).json.error.details[0].code).toBe("refund.currency_mismatch");
    expect((await request({ paymentId, amountMinor: 0, reason: "d" })).status).toBe(400);

    await call(voidRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: paymentId }, body: { reason: "Recorded on the wrong job" } });
    expect((await request({ paymentId, amountMinor: 100, reason: "e" })).json.error.details[0].code).toBe("refund.payment_not_received");
  });

  it("concurrent requests against one payment never take more than it holds (payment row lock)", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 5_000);
    const results = await Promise.all(Array.from({ length: 5 }, () => request({ paymentId, amountMinor: 3_000, reason: "Concurrent" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.json.error.details[0].code === "refund.exceeds_payment")).toBe(true);
  });
});

describe("refund needing approval (REFUND policy, separation of duties)", () => {
  it("waits for an approver; the requester can never approve; approval allows the payout", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 50_000);
    const response = await request({ paymentId, amountMinor: 20_000, reason: "Equipment returned" });
    expect(response.json.data).toMatchObject({ approvalRequired: true, refund: { status: "PENDING_APPROVAL" } });
    const { refund, approvalRequestId } = response.json.data;
    expect(refund.approvalRequestId).toBe(approvalRequestId);

    // §21.3: the Finance Director asked, so the Finance Director cannot decide (service check + trigger).
    await expect(approve(w.finance, approvalRequestId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await complete(refund.id)).json.error.code).toBe("INVALID_STATE_TRANSITION");

    await approve(w.ceo, approvalRequestId);
    const approved = (await call(getRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: refund.id } })).json.data;
    expect(approved).toMatchObject({ status: "APPROVED" });
    expect(approved.decidedAt).not.toBeNull();
    expect((await auditEvents(w.tenantId, "refund.approved", refund.id))[0].newValue).toMatchObject({ approverIds: [w.ceo.userId] });

    expect((await complete(refund.id)).json.data.refund.status).toBe("POSTED");
    expect((await ledgerOf(w, job.id)).filter((e) => e.type === "REFUND")).toHaveLength(1);
  });

  it("a rejection ends the refund (REJECTED, nothing posted) and frees the amount for a new request", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 20_000);
    const first = (await request({ paymentId, amountMinor: 20_000, reason: "Full refund" })).json.data;
    await reject(w.ceo, first.approvalRequestId, "Partial refund only");
    const rejected = (await call(getRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: first.refund.id } })).json.data;
    expect(rejected.status).toBe("REJECTED");
    expect((await ledgerOf(w, job.id)).map((e) => e.type)).toEqual(["PAYMENT"]);
    expect((await request({ paymentId, amountMinor: 5_000, reason: "Partial refund" })).status).toBe(201);
  });

  it("a payment voided after approval cannot be paid out; the refund is cancelled instead (approval request too)", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 30_000);
    const approved = (await request({ paymentId, amountMinor: 1_000, reason: "Small" })).json.data.refund;
    const pending = (await request({ paymentId, amountMinor: 15_000, reason: "Large" })).json.data;
    await call(voidRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: paymentId }, body: { reason: "Bounced" } });
    expect((await complete(approved.id)).json.error.details[0].code).toBe("refund.payment_not_received");

    expect((await cancel(approved.id)).json.data.refund.status).toBe("CANCELLED");
    expect((await cancel(pending.refund.id)).json.data.refund.status).toBe("CANCELLED");
    const request_ = await withTenant(w.tenantId, (tx) => tx.approvalRequest.findUniqueOrThrow({ where: { id: pending.approvalRequestId } }));
    expect(request_.status).toBe("CANCELLED");
    expect((await cancel(approved.id)).json.data.replayed).toBe(true);
    expect((await complete(approved.id)).json.error.code).toBe("INVALID_STATE_TRANSITION");
  });
});

describe("scope, permissions and append-only records", () => {
  it("a City A manager requests in City A only; City B and technicians see nothing; the requester cancels their own", async () => {
    const jobA = await makeJob(w);
    const jobB = await makeJob(w, { inCityB: true });
    const paymentA = await receivedPayment(w, jobA.id, 5_000);
    const paymentB = await receivedPayment(w, jobB.id, 5_000);

    const mine = await request({ paymentId: paymentA, amountMinor: 500, reason: "Goodwill" }, w.cookie.cityManagerA);
    expect(mine.status).toBe(201);
    expect((await request({ paymentId: paymentB, amountMinor: 500, reason: "x" }, w.cookie.cityManagerA)).status).toBe(404);
    expect((await request({ paymentId: paymentA, amountMinor: 500, reason: "x" }, w.cookie.techA1)).status).toBe(403);
    // Viewing is not requesting: the COO template holds finance_refunds.view only.
    expect((await request({ paymentId: paymentA, amountMinor: 500, reason: "x" }, w.cooCookie)).status).toBe(403);

    const refundId = mine.json.data.refund.id as string;
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, params: { id: refundId } })).status).toBe(404);
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.techA1, params: { id: refundId } })).status).toBe(403);
    const listB = await call(listRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, query: { jobId: jobA.id } });
    expect(listB.json.data).toEqual([]);
    const listA = await call(listRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, query: { jobId: jobA.id } });
    expect(listA.json.data.map((r: { id: string }) => r.id)).toEqual([refundId]);
    expect((await cancel(refundId, w.cookie.cityManagerB)).status).toBe(404);
    expect((await cancel(refundId, w.cookie.cityManagerA)).json.data.refund.status).toBe("CANCELLED");
  });

  it("the database refuses to edit or delete a refund's core facts and its ledger entry", async () => {
    const job = await makeJob(w);
    const paymentId = await receivedPayment(w, job.id, 5_000);
    const refundId = (await request({ paymentId, amountMinor: 700, reason: "Late arrival" })).json.data.refund.id as string;
    await complete(refundId);
    await expect(withTenant(w.tenantId, (tx) => tx.refund.update({ where: { id: refundId }, data: { amountMinor: 1n } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.refund.update({ where: { id: refundId }, data: { status: "APPROVED" } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.refund.delete({ where: { id: refundId } }))).rejects.toThrow();
    const entry = (await ledgerOf(w, job.id)).find((e) => e.type === "REFUND");
    await expect(withTenant(w.tenantId, (tx) => tx.ledgerEntry.update({ where: { id: entry?.id }, data: { amountMinor: -1n } }))).rejects.toThrow();
  });
});
