import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/finance/review-flags/[id]/assign/route";
import { POST as resolveRoute } from "@/app/api/v1/finance/review-flags/[id]/resolve/route";
import { GET as getRoute } from "@/app/api/v1/finance/review-flags/[id]/route";
import { POST as unassignRoute } from "@/app/api/v1/finance/review-flags/[id]/unassign/route";
import { GET as listRoute, POST as raiseRoute } from "@/app/api/v1/finance/review-flags/route";
import { POST as chargeRoute } from "@/app/api/v1/finance/outcomes/[id]/charge/route";
import { POST as assignJobRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { POST as createMaterialRoute } from "@/app/api/v1/materials/route";
import { POST as proposeCostRoute } from "@/app/api/v1/materials/[id]/costs/route";
import { POST as costUsageRoute } from "@/app/api/v1/materials/usages/[usageId]/cost/route";
import { withTenant } from "@/server/db";
import { raiseFinanceReviewFlagInTx } from "@/server/finance-adjustments";
import { correctJobOutcome, correctOutcomeSchema } from "@/server/job-outcomes";
import { disconnect } from "../authz/fixtures";
import { ledgerOf, makeJob, storeSoldOutcome } from "../finance/fixtures";
import { createJobViaApi } from "../jobs/fixtures";
import { auditEvents, call, contextFor } from "../org/org-helpers";
import { buildCorrectionsWorld, flagsOf, idempotencyHeader, receivedPayment, type CorrectionsWorld } from "./fixtures";

let w: CorrectionsWorld;

beforeAll(async () => {
  w = await buildCorrectionsWorld("review-flags");
});
afterAll(disconnect);

const raise = (body: Record<string, unknown>, cookie = w.cookie.finance, key: string | null = randomUUID()) =>
  call(raiseRoute, "POST", "/api/v1/finance/review-flags", { cookie, body, headers: key ? idempotencyHeader(key) : {} });
const act = (route: typeof assignRoute, id: string, body: Record<string, unknown> | undefined, cookie = w.cookie.finance) => call(route, "POST", "/x", { cookie, params: { id }, body });

describe("manual flags and the flag workflow", () => {
  it("a person flags a job with a note; the same key replays; refs must belong to the job", async () => {
    const job = await makeJob(w);
    const other = await makeJob(w);
    const paymentOfOther = await receivedPayment(w, other.id, 1_000);
    const key = randomUUID();
    const first = await raise({ jobId: job.id, note: "Customer disputes the invoice by phone" }, w.cookie.finance, key);
    expect(first.status).toBe(201);
    expect(first.json.data.flag).toMatchObject({ reasonCode: "manual.review_requested", status: "OPEN", raisedById: w.finance.userId, systemActor: null, orgUnitId: w.units.cityA, jobId: job.id });
    expect(first.json.data.flag.idempotencyKey).toBeUndefined();
    expect((await raise({ jobId: job.id, note: "Customer disputes the invoice by phone" }, w.cookie.finance, key)).json.data.flag.id).toBe(first.json.data.flag.id);
    expect((await raise({ jobId: job.id, note: "x", paymentId: paymentOfOther })).status).toBe(400);
    expect((await raise({ jobId: job.id, note: "x" }, w.cookie.finance, null)).json.error.details[0].code).toBe("review_flag.idempotency_key_required");
    // Managers see reconciliation but do not raise flags (no finance_reconciliation.create); technicians see nothing.
    expect((await raise({ jobId: job.id, note: "x" }, w.cookie.cityManagerA)).status).toBe(403);
    expect((await raise({ jobId: job.id, note: "x" }, w.cookie.techA1)).status).toBe(403);
    expect(await flagsOf(w, job.id)).toHaveLength(1);
  });

  it("assign (only to someone who can see it) -> unassign -> assign -> resolve with a reason; RESOLVED is final", async () => {
    const job = await makeJob(w);
    const flagId = (await raise({ jobId: job.id, note: "Check the discount" })).json.data.flag.id as string;
    // City B's manager cannot see a City A flag, so it cannot be given to them; a technician neither.
    const wrong = await act(assignRoute, flagId, { assigneeUserId: w.cityManagerB.userId });
    expect(wrong.json.error.details[0].code).toBe("review_flag.assignee_cannot_see");
    expect((await act(assignRoute, flagId, { assigneeUserId: w.techA1.userId })).status).toBe(400);

    const assigned = await act(assignRoute, flagId, { assigneeUserId: w.cityManagerA.userId });
    expect(assigned.json.data).toMatchObject({ status: "ASSIGNED", assignedToId: w.cityManagerA.userId });
    expect((await act(unassignRoute, flagId, undefined)).json.data).toMatchObject({ status: "OPEN", assignedToId: null });
    await act(assignRoute, flagId, { assigneeUserId: w.ceo.userId });
    // Managers read flags but neither assign nor resolve them.
    expect((await act(resolveRoute, flagId, { resolutionReason: "x" }, w.cookie.cityManagerA)).status).toBe(403);
    expect((await act(resolveRoute, flagId, {})).status).toBe(400);
    const resolved = await act(resolveRoute, flagId, { resolutionReason: "Adjustment posted for the missing discount" });
    expect(resolved.json.data).toMatchObject({ status: "RESOLVED", resolvedById: w.finance.userId, resolutionReason: "Adjustment posted for the missing discount" });
    expect((await act(resolveRoute, flagId, { resolutionReason: "again" })).json.error.code).toBe("INVALID_STATE_TRANSITION");
    expect((await act(assignRoute, flagId, { assigneeUserId: w.ceo.userId })).json.error.code).toBe("INVALID_STATE_TRANSITION");
    expect((await auditEvents(w.tenantId, "finance_review_flag.assign", flagId)).length).toBe(2);
    expect(await auditEvents(w.tenantId, "finance_review_flag.resolve", flagId)).toHaveLength(1);
    // What was flagged is frozen.
    await expect(withTenant(w.tenantId, (tx) => tx.financeReviewFlag.update({ where: { id: flagId }, data: { reasonCode: "manual.other" } }))).rejects.toThrow();
    await expect(withTenant(w.tenantId, (tx) => tx.financeReviewFlag.delete({ where: { id: flagId } }))).rejects.toThrow();
  });

  it("lists and reads by the flag's unit", async () => {
    const jobA = await makeJob(w);
    const jobB = await makeJob(w, { inCityB: true });
    const flagA = (await raise({ jobId: jobA.id, note: "A" })).json.data.flag.id as string;
    await raise({ jobId: jobB.id, note: "B" });
    const listA = await call(listRoute, "GET", "/x", { cookie: w.cookie.cityManagerA, query: { limit: "200" } });
    const units = new Set(listA.json.data.map((f: { orgUnitId: string }) => f.orgUnitId));
    expect([...units]).toEqual([w.units.cityA]);
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.cityManagerB, params: { id: flagA } })).status).toBe(404);
    expect((await call(getRoute, "GET", "/x", { cookie: w.cookie.techA1, params: { id: flagA } })).status).toBe(403);
    expect((await call(listRoute, "GET", "/x", { cookie: w.cookie.finance, query: { jobId: jobB.id } })).json.data).toHaveLength(1);
  });
});

describe("flags raised by the platform (idempotent per triggering event)", () => {
  const move = (jobId: string, toStatus: string, cookie = w.cookie.dispatcher) => call(transitionRoute, "POST", "/x", { cookie, params: { id: jobId }, body: { toStatus } });

  async function jobAwaitingReview(): Promise<string> {
    const job = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    await call(assignJobRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
    const start = Date.now() + 2 * 86_400_000;
    await call(rescheduleRoute, "POST", "/x", {
      cookie: w.cookie.dispatcher,
      params: { id: job.id },
      body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 7_200_000).toISOString() } },
    });
    for (const status of ["EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED", "AWAITING_REVIEW"]) expect((await move(job.id, status)).status).toBe(200);
    return job.id as string;
  }

  it("the same triggering event raised twice, even concurrently, is one flag and one audit row", async () => {
    const job = await makeJob(w);
    const key = `test_event:${randomUUID()}`;
    const raiseOnce = () =>
      withTenant(w.tenantId, (tx) =>
        raiseFinanceReviewFlagInTx(tx, { tenantId: w.tenantId, reasonCode: "job.reopened_after_posting", idempotencyKey: key, refs: { jobId: job.id }, orgUnitId: w.units.cityA, raisedBy: { system: "system:finance-review" }, ctx: null }),
      );
    const results = await Promise.all([raiseOnce(), raiseOnce(), raiseOnce()]);
    expect(new Set(results.map((r) => r.flag.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await auditEvents(w.tenantId, "finance_review_flag.raise", results[0].flag.id)).toHaveLength(1);
  });

  it("a job reopened after money was posted gets one flag per reopening; one without money gets none", async () => {
    const withMoney = await jobAwaitingReview();
    await receivedPayment(w, withMoney, 12_000);
    const without = await jobAwaitingReview();

    expect((await move(withMoney, "IN_PROGRESS", w.cookie.ceo)).status).toBe(200);
    expect((await move(without, "IN_PROGRESS", w.cookie.ceo)).status).toBe(200);
    const flags = await flagsOf(w, withMoney);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ reasonCode: "job.reopened_after_posting", systemActor: "system:finance-review", note: null, orgUnitId: w.units.cityA });
    expect(flags[0].details).toMatchObject({ fromStatus: "AWAITING_REVIEW", toStatus: "IN_PROGRESS", reopenedById: w.ceo.userId });
    expect(await flagsOf(w, without)).toHaveLength(0);
    // The posted money is untouched: reopening never edits the ledger.
    expect((await ledgerOf(w, withMoney)).map((e) => [e.type, e.amountMinor])).toEqual([["PAYMENT", 12_000n]]);

    // A second reopening is a second event, so a second flag.
    for (const status of ["COMPLETED", "AWAITING_REVIEW"]) await move(withMoney, status);
    await move(withMoney, "IN_PROGRESS", w.cookie.ceo);
    expect(await flagsOf(w, withMoney)).toHaveLength(2);
  });

  it("correcting the money of an outcome whose charge was posted raises one flag per correction; a notes-only correction none", async () => {
    const job = await makeJob(w);
    const outcomeId = await storeSoldOutcome(w, job.id, { charged: 40_000n });
    expect((await call(chargeRoute, "POST", "/x", { cookie: w.cookie.finance, params: { id: outcomeId }, body: { expectedAmountMinor: 40_000 } })).status).toBe(201);
    const ctx = contextFor(w.ceo.actor);
    await correctJobOutcome(w.ceo.actor, ctx, outcomeId, correctOutcomeSchema.parse({ reason: "Typo", notes: "Unit replaced" }));
    expect(await flagsOf(w, job.id)).toHaveLength(0);
    await correctJobOutcome(w.ceo.actor, ctx, outcomeId, correctOutcomeSchema.parse({ reason: "Discount agreed", chargedAmountMinor: 35_000 }));
    const flags = await flagsOf(w, job.id);
    expect(flags.map((f) => [f.reasonCode, f.outcomeId])).toEqual([["outcome.corrected_after_posting", outcomeId]]);
    expect(flags[0].details).toMatchObject({ changedFields: "chargedAmountMinor", correctedById: w.ceo.userId });
    // The CHARGE stays as posted; finance decides on an adjustment.
    expect((await ledgerOf(w, job.id)).map((e) => [e.type, e.amountMinor])).toEqual([["CHARGE", 40_000n]]);
  });

  it("costing a material usage posts one MATERIAL_COST entry (key MATERIAL_COST:<usageId>), separate from what is owed", async () => {
    const material = await call(createMaterialRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { code: `pipe-${randomUUID().slice(0, 8)}`, name: "Pipe", unit: "m" } });
    const materialId = material.json.data.id as string;
    expect((await call(proposeCostRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { id: materialId }, body: { currency: "USD", unitCostMinor: 425, effectiveFrom: "2020-01-01T00:00:00.000Z" } })).status).toBe(201);
    const job = await makeJob(w);
    const usage = await withTenant(w.tenantId, (tx) =>
      tx.jobMaterialUsage.create({ data: { tenantId: w.tenantId, jobId: job.id, name: "Pipe", materialId, quantity: "1.500", unit: "m", occurredAt: new Date(Date.now() - 3_600_000) } }),
    );
    const costed = await call(costUsageRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { usageId: usage.id }, body: {} });
    expect(costed.status).toBe(200);
    // 1.5 m x 4.25 = 6.375 -> 6.38 (half-even rounding happens in materials, once).
    const entries = await ledgerOf(w, job.id);
    expect(entries.map((e) => [e.type, e.source, e.amountMinor, e.materialUsageId, e.idempotencyKey])).toEqual([["MATERIAL_COST", "MATERIAL_USAGE", -638n, usage.id, `MATERIAL_COST:${usage.id}`]]);
    expect((await call(costUsageRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { usageId: usage.id }, body: {} })).status).toBe(409);
    expect(await ledgerOf(w, job.id)).toHaveLength(1);
  });
});
