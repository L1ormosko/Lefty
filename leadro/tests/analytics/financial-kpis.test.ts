import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getKpi } from "@/app/api/v1/analytics/kpis/[key]/route";
import { localIsoDate } from "@/lib/zoned-time";
import { computeKpi, type KpiQuery, type KpiResult } from "@/server/analytics";
import type { Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import {
  completeRefund,
  recordChargeback,
  recordChargebackSchema,
  requestAdjustment,
  requestAdjustmentSchema,
  requestRefund,
  requestRefundSchema,
} from "@/server/finance-adjustments";
import { reverseCharge } from "@/server/ledger";
import { costMaterialUsage, createMaterial, createMaterialSchema, proposeCostSchema, proposeCostVersion } from "@/server/materials";
import { confirmChargeSchema, confirmCollectionSchema, confirmOutcomeCharge, confirmOutcomeCollection } from "@/server/payments";
import { resolveReconciliationException, startReconciliationRun } from "@/server/reconciliation";
import { disconnect } from "../authz/fixtures";
import { makeJob } from "../finance/fixtures";
import { buildCorrectionsWorld, type CorrectionsWorld } from "../finance-adjustments/fixtures";
import { call, contextFor } from "../org/org-helpers";

/**
 * Financial KPIs (spec 13.1, 13.3) over REAL ledger postings made through the owning modules' public APIs: finance-confirmed
 * charges and collections (payments), a reversed charge (ledger), a refund, a chargeback and an adjustment (finance-adjustments),
 * a costed material line (materials) and a reconciliation run with one resolved exception (reconciliation). Outcomes are stored
 * straight in the database, as the technician reported them (finance tests do the same). Money is per currency, never summed.
 */

let w: CorrectionsWorld;
let range: KpiQuery;
const ids: Record<string, string> = {};
const HOUR = 3_600_000;

const run = (actor: Actor, key: string, query: Partial<KpiQuery> = {}) => computeKpi(actor, key, { ...range, ...query });
/** [currency, value] per row (TENANT level: one row per currency). */
const money = (result: KpiResult) => result.rows.map((row) => [row.currency, row.value]);
const byCity = (result: KpiResult) => Object.fromEntries(result.rows.map((row) => [`${row.orgUnitId}:${row.currency}`, row.value]));

/** A SOLD visit on the job's current visit, with the amounts the technician reported. */
async function soldOutcome(jobId: string, amounts: { approved: bigint; charged: bigint; collected?: bigint; currency?: string }): Promise<string> {
  return withTenant(w.tenantId, async (tx) => {
    const job = await tx.job.findFirstOrThrow({ where: { id: jobId }, select: { currentVisitNumber: true } });
    const outcome = await tx.jobOutcome.create({
      data: {
        tenantId: w.tenantId,
        jobId,
        visitNumber: job.currentVisitNumber,
        outcome: "SOLD",
        employeeId: w.techA1.employeeId,
        approvedAmountMinor: amounts.approved,
        chargedAmountMinor: amounts.charged,
        collectedAmountMinor: amounts.collected ?? null,
        currency: amounts.currency ?? "USD",
        paymentMethod: amounts.collected ? "CASH" : null,
        paymentStatus: amounts.collected ? "PARTIAL" : "PENDING",
        occurredAt: new Date(Date.now() - 3 * HOUR),
      },
    });
    return outcome.id;
  });
}

const finance = () => w.finance.actor;
const ctx = () => contextFor(w.finance.actor);

async function confirmCharge(outcomeId: string, amount: number): Promise<string> {
  return (await confirmOutcomeCharge(finance(), ctx(), outcomeId, confirmChargeSchema.parse({ expectedAmountMinor: amount }))).entryId;
}
async function confirmCollection(outcomeId: string, amount: number): Promise<string> {
  return (await confirmOutcomeCollection(finance(), ctx(), outcomeId, confirmCollectionSchema.parse({ expectedAmountMinor: amount }))).payment.id;
}

beforeAll(async () => {
  w = await buildCorrectionsWorld("kpi-financial");
  const tenant = await withTenant(w.tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: w.tenantId }, select: { defaultTimeZone: true } }));
  const now = Date.now();
  range = {
    from: localIsoDate(now - 2 * 24 * HOUR, tenant.defaultTimeZone),
    to: localIsoDate(now + 24 * HOUR, tenant.defaultTimeZone),
    period: "TOTAL",
    groupBy: "TENANT",
  };

  // A1 (City A): sold 500.00, charged 500.00, 200.00 collected; 50.00 refunded, a 30.00 goodwill credit, 2 m of pipe at 12.50.
  ids.a1 = (await makeJob(w)).id;
  const a1Outcome = await soldOutcome(ids.a1, { approved: 50_000n, charged: 50_000n, collected: 20_000n });
  await confirmCharge(a1Outcome, 50_000);
  const a1Payment = await confirmCollection(a1Outcome, 20_000);
  const refund = await requestRefund(finance(), ctx(), requestRefundSchema.parse({ paymentId: a1Payment, amountMinor: 5_000, reason: "Part of the work was redone" }), randomUUID());
  await completeRefund(finance(), ctx(), refund.refund.id, {});
  await requestAdjustment(
    finance(),
    ctx(),
    requestAdjustmentSchema.parse({ jobId: ids.a1, amountMinor: -3_000, reasonCode: "goodwill_credit", reason: "Late arrival" }),
    randomUUID(),
  );
  const material = await createMaterial(w.ceo.actor, contextFor(w.ceo.actor), createMaterialSchema.parse({ code: `pipe-${randomUUID().slice(0, 8)}`, name: "Pipe", unit: "m" }));
  await proposeCostVersion(
    w.ceo.actor,
    contextFor(w.ceo.actor),
    material.id as string,
    proposeCostSchema.parse({ unitCostMinor: 1_250, currency: "USD", effectiveFrom: new Date(now - 30 * 24 * HOUR).toISOString() }),
  );
  const usage = await withTenant(w.tenantId, (tx) =>
    tx.jobMaterialUsage.create({
      data: { tenantId: w.tenantId, jobId: ids.a1, name: "Pipe", materialId: material.id as string, quantity: "2", unit: "m", occurredAt: new Date(now - 2 * HOUR) },
    }),
  );
  await costMaterialUsage(finance(), ctx(), usage.id, {});

  // B1 (City B): sold, charged and collected 100.00; the card network takes 40.00 back.
  ids.b1 = (await makeJob(w, { inCityB: true })).id;
  const b1Outcome = await soldOutcome(ids.b1, { approved: 10_000n, charged: 10_000n, collected: 10_000n });
  await confirmCharge(b1Outcome, 10_000);
  const b1Payment = await confirmCollection(b1Outcome, 10_000);
  await recordChargeback(finance(), ctx(), recordChargebackSchema.parse({ paymentId: b1Payment, amountMinor: 4_000 }), randomUUID());

  // B2 (City B): charged 70.00 by mistake, then reversed.
  ids.b2 = (await makeJob(w, { inCityB: true })).id;
  const b2Charge = await confirmCharge(await soldOutcome(ids.b2, { approved: 7_000n, charged: 7_000n }), 7_000);
  await reverseCharge(finance(), ctx(), b2Charge, { reason: "Charged the wrong job" });

  // C1 (City A) in Canadian dollars: never added to the USD figures.
  ids.c1 = (await makeJob(w)).id;
  await withTenant(w.tenantId, (tx) => tx.job.update({ where: { id: ids.c1 }, data: { currency: "CAD" } }));
  await confirmCharge(await soldOutcome(ids.c1, { approved: 9_900n, charged: 9_900n, currency: "CAD" }), 9_900);

  // Reconciliation over the last two days; one exception resolved.
  await startReconciliationRun(finance(), ctx(), { currency: "USD", periodStart: new Date(now - 2 * 24 * HOUR), periodEnd: new Date() });
  const first = await withTenant(w.tenantId, (tx) => tx.reconciliationException.findFirstOrThrow({ where: { tenantId: w.tenantId, jobId: ids.b1 }, orderBy: { id: "asc" } }));
  ids.resolved = first.id;
  await resolveReconciliationException(finance(), ctx(), first.id, { reason: "Chargeback accepted, customer informed" });
});
afterAll(disconnect);

describe("ledger-derived money (spec 13.3)", () => {
  it("sums charged, collected, refunded, charged-back and adjusted amounts per currency, reversals under the type they reverse", async () => {
    expect(money(await run(finance(), "charged_revenue"))).toEqual([["CAD", 9_900n], ["USD", 60_000n]]);
    expect(money(await run(finance(), "collected_revenue"))).toEqual([["USD", 30_000n]]);
    expect(money(await run(finance(), "refunds"))).toEqual([["USD", 5_000n]]);
    expect(money(await run(finance(), "chargebacks"))).toEqual([["USD", 4_000n]]);
    expect(money(await run(finance(), "adjustments"))).toEqual([["USD", -3_000n]]);
  });

  it("derives costs and gross profit (charged minus direct costs, materials only)", async () => {
    expect(money(await run(finance(), "material_costs"))).toEqual([["USD", 2_500n]]);
    expect(money(await run(finance(), "direct_costs"))).toEqual([["USD", 2_500n]]);
    expect(money(await run(finance(), "gross_profit"))).toEqual([["CAD", 9_900n], ["USD", 57_500n]]);
  });

  it("gives outstanding as a snapshot: billed minus net collected", async () => {
    const result = await computeKpi(finance(), "outstanding_amount", { period: "TOTAL", groupBy: "CITY" });
    expect(result.from).toBeNull();
    // City A: 500 - 30 billed, 200 - 50 net; City B: 100 billed, 100 - 40 net; B2's reversed charge leaves nothing.
    expect(byCity(result)).toEqual({ [`${w.units.cityA}:CAD`]: 9_900n, [`${w.units.cityA}:USD`]: 32_000n, [`${w.units.cityB}:USD`]: 4_000n });
  });

  it("reports sold (approved) revenue from the outcomes, apart from what the ledger charged", async () => {
    expect(money(await run(finance(), "sold_revenue"))).toEqual([["CAD", 9_900n], ["USD", 67_000n]]);
  });

  it("lists ledger entry ids for drill-down and ignores entries outside the range", async () => {
    const result = await run(finance(), "charged_revenue", { groupBy: "CITY" });
    expect(result.drillDown).toMatchObject({ recordType: "LedgerEntry", anchor: "LedgerEntry.occurredAt" });
    const cityB = result.rows.find((row) => row.orgUnitId === w.units.cityB);
    expect(cityB).toMatchObject({ value: 10_000n, sampleCount: 3 }); // B1's charge, B2's charge and its reversal
    expect((await run(finance(), "charged_revenue", { from: "2020-01-01", to: "2020-01-31" })).rows).toEqual([]);
  });
});

describe("reconciliation exceptions", () => {
  it("counts open exceptions now and resolutions in the period", async () => {
    const open = await withTenant(w.tenantId, (tx) => tx.reconciliationException.count({ where: { tenantId: w.tenantId, status: { in: ["OPEN", "ASSIGNED"] } } }));
    expect(open).toBeGreaterThan(0);
    const openKpi = await computeKpi(finance(), "reconciliation_exceptions_open", { period: "TOTAL", groupBy: "TENANT" });
    expect(openKpi.rows[0]).toMatchObject({ value: open });
    expect(openKpi.rows[0].recordIds).not.toContain(ids.resolved);
    expect((await run(finance(), "reconciliation_exceptions_resolved")).rows[0]).toMatchObject({ value: 1, recordIds: [ids.resolved] });
  });
});

describe("access: financial_reports.view plus the source module's sensitive set (Phase 6 Task 3)", () => {
  it("limits a city manager to their unit's revenue and refuses them material costs and gross profit", async () => {
    const manager = w.cityManagerA.actor;
    expect(money(await run(manager, "charged_revenue"))).toEqual([["CAD", 9_900n], ["USD", 50_000n]]);
    expect(money(await run(manager, "sold_revenue"))).toEqual([["CAD", 9_900n], ["USD", 50_000n]]);
    expect((await run(manager, "reconciliation_exceptions_resolved")).rows).toEqual([]); // the resolved one is City B's
    for (const key of ["material_costs", "direct_costs", "gross_profit"]) await expect(run(manager, key)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("gives the COO revenue and sold amounts but no costs (no materials cost set)", async () => {
    expect(money(await run(w.cooPerson.actor, "collected_revenue"))).toEqual([["USD", 30_000n]]);
    expect(money(await run(w.cooPerson.actor, "sold_revenue"))).toEqual([["CAD", 9_900n], ["USD", 67_000n]]);
    await expect(run(w.cooPerson.actor, "gross_profit")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses technicians every financial KPI", async () => {
    for (const key of ["charged_revenue", "sold_revenue", "outstanding_amount"]) {
      await expect(computeKpi(w.techA1.actor, key, { ...range })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("serializes money as strings over the API and keeps compensation BLOCKED_ON_SPEC", async () => {
    const response = await call(getKpi, "GET", "/x", { cookie: w.cookie.finance, params: { key: "charged_revenue" }, query: { from: range.from as string, to: range.to as string } });
    expect(response.status).toBe(200);
    expect(response.json.data.rows.map((row: { currency: string; value: string }) => [row.currency, row.value])).toEqual([["CAD", "9900"], ["USD", "60000"]]);
    const blocked = await call(getKpi, "GET", "/x", { cookie: w.cookie.finance, params: { key: "commission_expense" }, query: { from: range.from as string, to: range.to as string } });
    expect(blocked.json.data).toMatchObject({ status: "BLOCKED_ON_SPEC", rows: [] });
  });
});
