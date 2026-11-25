import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as cancelRoute } from "@/app/api/v1/finance/adjustments/[id]/cancel/route";
import { GET as getRoute } from "@/app/api/v1/finance/adjustments/[id]/route";
import { GET as listRoute, POST as requestRoute } from "@/app/api/v1/finance/adjustments/route";
import { GET as jobBalanceRoute } from "@/app/api/v1/finance/jobs/[id]/balance/route";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { ledgerOf, makeJob, storeSoldOutcome } from "../finance/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { addPolicy, approve, buildCorrectionsWorld, idempotencyHeader, reject, type CorrectionsWorld } from "./fixtures";

let w: CorrectionsWorld;

beforeAll(async () => {
  w = await buildCorrectionsWorld("adjustments");
  // Below 10.00 nobody; 10.00 up to 500.00 one approver; 500.00 and more two different approvers.
  await addPolicy(w, "ADJUSTMENT", { min: 1_000, max: 50_000 });
  await addPolicy(w, "ADJUSTMENT", { min: 50_000, requiredApprovals: 2 });
});
afterAll(disconnect);

const request = (body: Record<string, unknown>, cookie = w.cookie.finance, key: string | null = randomUUID()) =>
  call(requestRoute, "POST", "/api/v1/finance/adjustments", { cookie, body, headers: key ? idempotencyHeader(key) : {} });
const balance = async (jobId: string) => (await call(jobBalanceRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobId } })).json.data.balances[0];

const ADJUSTMENT_FIELDS = [
  "amountMinor",
  "approvalRequestId",
  "createdAt",
  "currency",
  "customerId",
  "decidedAt",
  "id",
  "jobId",
  "orgUnitId",
  "outcomeId",
  "postedAt",
  "reason",
  "reasonCode",
  "requestedAt",
  "requestedById",
  "status",
  "updatedAt",
];

describe("adjustments without approval", () => {
  it("a small credit is approved AND posted at once: one ADJUSTMENT entry, billed drops", async () => {
    const job = await makeJob(w);
    const response = await request({ jobId: job.id, amountMinor: -500, reasonCode: "goodwill_credit", reason: "Arrived late" });
    expect(response.status).toBe(201);
    const adjustment = response.json.data.adjustment;
    expect(response.json.data).toMatchObject({ approvalRequired: false, approvalRequestId: null });
    expect(adjustment).toMatchObject({ status: "POSTED", amountMinor: "-500", reasonCode: "goodwill_credit", requestedById: w.finance.userId });
    expect(Object.keys(adjustment).sort()).toEqual(ADJUSTMENT_FIELDS);
    const entries = await ledgerOf(w, job.id);
    expect(entries.map((e) => [e.type, e.source, e.amountMinor, e.adjustmentId, e.idempotencyKey])).toEqual([
      ["ADJUSTMENT", "ADJUSTMENT", -500n, adjustment.id, `adjustment:${adjustment.id}:posted`],
    ]);
    expect(await balance(job.id)).toMatchObject({ adjustedMinor: "-500", billedMinor: "-500" });
    expect(await auditEvents(w.tenantId, "adjustment.post", adjustment.id)).toHaveLength(1);
  });

  it("validates the input: never zero, a known reason code, the job's currency, an outcome of the same job, no employee field", async () => {
    const job = await makeJob(w);
    const other = await makeJob(w);
    const outcomeOfOther = await storeSoldOutcome(w, other.id, { charged: 10_000n });
    expect((await request({ jobId: job.id, amountMinor: 0, reasonCode: "other", reason: "x" })).status).toBe(400);
    expect((await request({ jobId: job.id, amountMinor: 100, reasonCode: "wage_deduction", reason: "x" })).status).toBe(400);
    expect((await request({ jobId: job.id, amountMinor: 100, currency: "EUR", reasonCode: "other", reason: "x" })).json.error.details[0].code).toBe("adjustment.currency_mismatch");
    expect((await request({ jobId: job.id, amountMinor: 100, reasonCode: "outcome_corrected", reason: "x", outcomeId: outcomeOfOther })).json.error.details[0].code).toBe(
      "adjustment.outcome_not_of_job",
    );
    // §11.7: an adjustment never targets an employee (no wage deduction, no commission effect): the field does not exist.
    expect((await request({ jobId: job.id, amountMinor: -100, reasonCode: "other", reason: "x", employeeId: w.techA1.employeeId })).status).toBe(400);
    expect((await request({ jobId: job.id, amountMinor: 100, reasonCode: "other", reason: "x" }, w.cookie.finance, null)).json.error.details[0].code).toBe(
      "adjustment.idempotency_key_required",
    );
    expect(await ledgerOf(w, job.id)).toHaveLength(0);
  });

  it("the same key replays; concurrent duplicates post one entry", async () => {
    const job = await makeJob(w);
    const key = randomUUID();
    const body = { jobId: job.id, amountMinor: 300, reasonCode: "price_change", reason: "Extra part" };
    const results = await Promise.all(Array.from({ length: 4 }, () => request(body, w.cookie.finance, key)));
    const ok = results.filter((r) => r.status === 200 || r.status === 201);
    expect(new Set(ok.map((r) => r.json.data.adjustment.id)).size).toBe(1);
    expect(await ledgerOf(w, job.id)).toHaveLength(1);
  });
});

describe("adjustments needing approval", () => {
  it("single approval: pending until a different person approves, then posted with the approver as ledger actor", async () => {
    const job = await makeJob(w);
    const response = (await request({ jobId: job.id, amountMinor: 20_000, reasonCode: "billing_correction", reason: "Second unit installed" })).json.data;
    expect(response).toMatchObject({ approvalRequired: true, adjustment: { status: "PENDING_APPROVAL" } });
    expect(await ledgerOf(w, job.id)).toHaveLength(0);
    await expect(approve(w.finance, response.approvalRequestId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await approve(w.approver2, response.approvalRequestId);
    const posted = (await call(getRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: response.adjustment.id } })).json.data;
    expect(posted).toMatchObject({ status: "POSTED" });
    const [entry] = await ledgerOf(w, job.id);
    expect(entry).toMatchObject({ type: "ADJUSTMENT", amountMinor: 20_000n, actorUserId: w.approver2.userId });
  });

  it("a large CREDIT needs the same scrutiny as a large debit (band on the absolute amount): two approvers", async () => {
    const job = await makeJob(w);
    const response = (await request({ jobId: job.id, amountMinor: -60_000, reasonCode: "goodwill_credit", reason: "Botched install" }, w.cookie.cityManagerA)).json.data;
    expect(response.approvalRequired).toBe(true);
    await approve(w.ceo, response.approvalRequestId);
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: response.adjustment.id } })).json.data.status).toBe("PENDING_APPROVAL");
    // The same approver twice is still one decision.
    await expect(approve(w.ceo, response.approvalRequestId)).rejects.toMatchObject({ code: "CONFLICT" });
    await approve(w.finance, response.approvalRequestId);
    expect((await ledgerOf(w, job.id)).map((e) => e.amountMinor)).toEqual([-60_000n]);
  });

  it("rejected = nothing posted; cancelled by the requester = nothing posted; a posted one cannot be cancelled", async () => {
    const job = await makeJob(w);
    const rejected = (await request({ jobId: job.id, amountMinor: 5_000, reasonCode: "other", reason: "a" })).json.data;
    await reject(w.ceo, rejected.approvalRequestId);
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: rejected.adjustment.id } })).json.data.status).toBe("REJECTED");

    const pending = (await request({ jobId: job.id, amountMinor: 5_000, reasonCode: "other", reason: "b" }, w.cookie.cityManagerA)).json.data;
    // Another City manager cannot even see it; the requester cancels it.
    expect((await call(cancelRoute, "POST", "/x", { cookie: w.cookie.cityManagerB, params: { id: pending.adjustment.id }, body: { reason: "x" } })).status).toBe(404);
    const cancelled = await call(cancelRoute, "POST", "/x", { cookie: w.cookie.cityManagerA, params: { id: pending.adjustment.id }, body: { reason: "Wrong job" } });
    expect(cancelled.json.data.adjustment.status).toBe("CANCELLED");
    const approvalRow = await withTenant(w.tenantId, (tx) => tx.approvalRequest.findUniqueOrThrow({ where: { id: pending.approvalRequestId } }));
    expect(approvalRow.status).toBe("CANCELLED");

    const posted = (await request({ jobId: job.id, amountMinor: 100, reasonCode: "other", reason: "c" })).json.data.adjustment;
    expect((await call(cancelRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: posted.id }, body: { reason: "x" } })).json.error.code).toBe("INVALID_STATE_TRANSITION");
    expect((await ledgerOf(w, job.id)).map((e) => e.amountMinor)).toEqual([100n]);
  });
});

describe("corrections are explicit and reproducible", () => {
  it("a mistaken adjustment is corrected by a counter-adjustment; the original record and entry stay as they were", async () => {
    const job = await makeJob(w);
    const original = (await request({ jobId: job.id, amountMinor: 800, reasonCode: "price_change", reason: "Typo: should be 80" })).json.data.adjustment;
    const counter = (await request({ jobId: job.id, amountMinor: -720, reasonCode: "billing_correction", reason: `Corrects ${original.id}` })).json.data.adjustment;
    const entries = await ledgerOf(w, job.id);
    expect(entries.map((e) => [e.adjustmentId, e.amountMinor])).toEqual([
      [original.id, 800n],
      [counter.id, -720n],
    ]);
    expect(await balance(job.id)).toMatchObject({ adjustedMinor: "80" });
    await expect(withTenant(w.tenantId, (tx) => tx.adjustment.update({ where: { id: original.id }, data: { amountMinor: 80n } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.adjustment.delete({ where: { id: original.id } }))).rejects.toThrow();
  });

  it("lists follow the job's unit; technicians and people without finance access get 403", async () => {
    const jobA = await makeJob(w);
    const id = (await request({ jobId: jobA.id, amountMinor: 50, reasonCode: "other", reason: "x" })).json.data.adjustment.id;
    expect((await call(listRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, query: { jobId: jobA.id } })).json.data.map((a: { id: string }) => a.id)).toEqual([id]);
    expect((await call(listRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, query: { jobId: jobA.id } })).json.data).toEqual([]);
    expect((await call(listRoute, "GET", "/x", { cookie: w.cookie.techA1 })).status).toBe(403);
    expect((await call(listRoute, "GET", "/x", { cookie: w.cookie.dispatcher })).status).toBe(403);
    expect((await request({ jobId: jobA.id, amountMinor: 50, reasonCode: "other", reason: "x" }, w.cookie.techA1)).status).toBe(403);
  });
});
