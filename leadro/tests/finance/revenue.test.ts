import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as queueRoute } from "@/app/api/v1/finance/charges-to-confirm/route";
import { POST as reverseRoute } from "@/app/api/v1/finance/ledger/entries/[id]/reverse/route";
import { GET as jobBalanceRoute } from "@/app/api/v1/finance/jobs/[id]/balance/route";
import { POST as chargeRoute } from "@/app/api/v1/finance/outcomes/[id]/charge/route";
import { POST as collectionRoute } from "@/app/api/v1/finance/outcomes/[id]/collection/route";
import { POST as voidRoute } from "@/app/api/v1/finance/payments/[id]/void/route";
import { withTenant } from "@/server/db";
import { createPerson, disconnect, grantTemplate, makeRole } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";
import { buildFinanceWorld, ledgerOf, makeJob, storeSoldOutcome, type FinanceWorld } from "./fixtures";

let w: FinanceWorld;

beforeAll(async () => {
  w = await buildFinanceWorld("revenue");
});
afterAll(disconnect);

const confirmCharge = (outcomeId: string, expectedAmountMinor: number | string, cookie = w.cookie.finance) =>
  call(chargeRoute, "POST", "/x", { cookie, params: { id: outcomeId }, body: { expectedAmountMinor } });
const confirmCollection = (outcomeId: string, body: Record<string, unknown>, cookie = w.cookie.finance) =>
  call(collectionRoute, "POST", "/x", { cookie, params: { id: outcomeId }, body });
const queue = (query: Record<string, string> = {}, cookie = w.cookie.finance) => call(queueRoute, "GET", "/x", { cookie, query });
const balanceOf = async (jobId: string) => (await call(jobBalanceRoute, "GET", "/x", { cookie: w.cookie.finance, params: { id: jobId } })).json.data.balances;

describe("revenue from outcomes is finance-confirmed, never automatic", () => {
  it("an outcome alone posts nothing; it appears in the queue with its amounts as PENDING", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 50_000n, collected: 20_000n, method: "CASH" });
    expect(await ledgerOf(w, job.id)).toHaveLength(0);
    const rows = (await queue({ jobId: job.id })).json.data;
    expect(rows).toMatchObject([
      {
        outcomeId,
        jobId: job.id,
        chargedAmountMinor: "50000",
        collectedAmountMinor: "20000",
        paymentMethod: "CASH",
        charge: { state: "PENDING", postedMinor: "0" },
        collection: { state: "PENDING", recordedMinor: "0" },
      },
    ]);
  });

  it("finance posts the CHARGE and records the collection; the job shows PARTIAL; the queue empties", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 50_000n, collected: 20_000n, method: "CASH" });
    const charged = await confirmCharge(outcomeId, 50_000);
    expect(charged.status).toBe(201);
    expect(charged.json.data).toMatchObject({ replayed: false, amountMinor: "50000", balances: [{ chargedMinor: "50000", paymentStatus: "UNPAID" }] });
    const collected = await confirmCollection(outcomeId, { expectedAmountMinor: 20_000 });
    expect(collected.status).toBe(201);
    expect(collected.json.data.payment).toMatchObject({ outcomeId, method: "CASH", status: "RECEIVED", origin: "MANUAL", amountMinor: "20000" });

    const entries = await ledgerOf(w, job.id);
    expect(entries.map((e) => [e.type, e.source, e.amountMinor, e.outcomeId, e.idempotencyKey])).toEqual([
      ["CHARGE", "OUTCOME", 50_000n, outcomeId, `outcome:${outcomeId}:charge:1`],
      ["PAYMENT", "PAYMENT", 20_000n, outcomeId, `payment:${collected.json.data.payment.id}:received`],
    ]);
    expect((await balanceOf(job.id))[0]).toMatchObject({ chargedMinor: "50000", collectedMinor: "20000", outstandingMinor: "30000", paymentStatus: "PARTIAL" });
    expect((await queue({ jobId: job.id })).json.data).toEqual([]);
    expect((await queue({ jobId: job.id, state: "all" })).json.data[0]).toMatchObject({ charge: { state: "POSTED" }, collection: { state: "POSTED" } });
    expect(await auditEvents(w.tenantId, "revenue.charge_confirm", outcomeId)).toHaveLength(1);
  });

  it("confirming twice, or concurrently, posts once", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 9_900n, collected: 9_900n, method: "CASH" });
    const results = await Promise.all(Array.from({ length: 6 }, () => confirmCharge(outcomeId, 9_900)));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const collections = await Promise.all(Array.from({ length: 6 }, () => confirmCollection(outcomeId, { expectedAmountMinor: 9_900 })));
    expect(collections.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(collections.map((r) => r.json.data.payment.id)).size).toBe(1);
    const entries = await ledgerOf(w, job.id);
    expect(entries.map((e) => e.type).sort()).toEqual(["CHARGE", "PAYMENT"]);
    expect((await balanceOf(job.id))[0].paymentStatus).toBe("PAID");
    expect((await confirmCharge(outcomeId, 9_900)).json.data.replayed).toBe(true);
  });

  it("refuses a confirmation of an amount that changed since it was shown", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 10_000n });
    const response = await confirmCharge(outcomeId, 12_000);
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("revenue.outcome_changed");
    expect((await confirmCollection(outcomeId, { expectedAmountMinor: 1 })).json.error.details[0].code).toBe("revenue.nothing_to_collect");
    expect(await ledgerOf(w, job.id)).toHaveLength(0);
  });

  it("a corrected outcome is a MISMATCH; finance reverses the charge and confirms again (attempt 2)", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 10_000n });
    const first = await confirmCharge(outcomeId, 10_000);
    await withTenant(w.tenantId, (tx) => tx.jobOutcome.update({ where: { id: outcomeId }, data: { chargedAmountMinor: 8_000n } }));
    expect((await queue({ jobId: job.id, state: "all" })).json.data[0].charge).toMatchObject({ state: "MISMATCH", postedMinor: "10000" });
    expect((await confirmCharge(outcomeId, 8_000)).json.error.details[0].code).toBe("revenue.charge_already_posted");

    const reversed = await call(reverseRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: first.json.data.entryId }, body: { reason: "Outcome corrected to 80.00" } });
    expect(reversed.status).toBe(201);
    expect((await queue({ jobId: job.id })).json.data[0].charge.state).toBe("PENDING");
    expect((await confirmCharge(outcomeId, 8_000)).status).toBe(201);
    const entries = await ledgerOf(w, job.id);
    expect(entries.map((e) => [e.type, e.amountMinor])).toEqual([
      ["CHARGE", 10_000n],
      ["REVERSAL", -10_000n],
      ["CHARGE", 8_000n],
    ]);
    expect(entries[2].idempotencyKey).toBe(`outcome:${outcomeId}:charge:2`);
    expect((await balanceOf(job.id))[0]).toMatchObject({ chargedMinor: "8000", paymentStatus: "UNPAID" });
  });

  it("a voided collection can be confirmed again; a reference is needed for card", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 3_000n, collected: 3_000n, method: "CARD" });
    expect((await confirmCollection(outcomeId, { expectedAmountMinor: 3_000 })).status).toBe(400);
    const first = await confirmCollection(outcomeId, { expectedAmountMinor: 3_000, reference: "TERM-555" });
    await call(voidRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: first.json.data.payment.id }, body: { reason: "Wrong terminal slip" } });
    const second = await confirmCollection(outcomeId, { expectedAmountMinor: 3_000, reference: "TERM-556" });
    expect(second.status).toBe(201);
    expect(second.json.data.payment.id).not.toBe(first.json.data.payment.id);
    expect((await balanceOf(job.id))[0]).toMatchObject({ collectedMinor: "3000" });
  });
});

describe("who may confirm revenue", () => {
  it("needs finance_payments.create (COO and unit managers only view) and the outcome financial set", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 1_000n });
    expect((await confirmCharge(outcomeId, 1_000, w.cooCookie)).status).toBe(403);
    expect((await confirmCharge(outcomeId, 1_000, w.cookie.cityManagerA)).status).toBe(403);
    expect((await confirmCharge(outcomeId, 1_000, w.cookie.dispatcher)).status).toBe(403);
    expect((await confirmCharge(outcomeId, 1_000, w.cookie.techA1)).status).toBe(403);

    // A custom finance role WITHOUT the outcome financial set: no queue rows, and no confirmation.
    const roleId = await makeRole(w.tenantId, "Payments clerk", [
      { permission: "finance_payments.view" },
      { permission: "finance_payments.create" },
      { permission: "job_outcomes.view" },
    ]);
    const clerk = await createPerson(w.tenantId, "clerk", { withEmployee: false });
    await grantTemplate(w.tenantId, clerk, roleId, [{ type: "TENANT" }]);
    const clerkCookie = await sessionCookie(clerk, w.tenantId);
    expect((await queue({ jobId: job.id }, clerkCookie)).json.data).toEqual([]);
    const refused = await confirmCharge(outcomeId, 1_000, clerkCookie);
    expect(refused.status).toBe(403);
    expect(refused.json.error.details[0].code).toBe("revenue.financial_set_required");
    expect(await ledgerOf(w, job.id)).toHaveLength(0);
  });

  it("the queue is scoped: a City B manager does not see City A outcomes", async () => {
    const jobA = await makeJob(w);
    const jobB = await makeJob(w, { inCityB: true });
    await storeSoldOutcome(w, jobA.id, { charged: 100n });
    await storeSoldOutcome(w, jobB.id, { charged: 200n });
    const seen = (await queue({}, w.cookie.cityManagerB)).json.data.map((row: { jobId: string }) => row.jobId);
    expect(seen).toContain(jobB.id);
    expect(seen).not.toContain(jobA.id);
  });
});
