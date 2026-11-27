import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeKpi, withReportingTenant, type KpiQuery, type KpiResult } from "@/server/analytics";
import type { Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { createTenant } from "../helpers";
import { auditEvents } from "../org/org-helpers";
import { at, buildAnalyticsWorld, insertJob, type AnalyticsWorld } from "./fixtures";

/**
 * The KPI engine (spec 13.2, 13.4): values per period in the tenant time zone and per org level, attribution (record snapshot;
 * employees by the placement effective at the event, spec 3), the KPI's own permission + field set over the viewer's scope,
 * dispatch_kpis, BLOCKED_ON_SPEC, confirmed vs estimated recovery money (spec 9.7), and the read client.
 */

let w: AnalyticsWorld;
const ids: Record<string, string> = {};
const MARCH: KpiQuery = { from: "2026-03-01", to: "2026-03-31", period: "TOTAL", groupBy: "TENANT" };

const run = (actor: Actor, key: string, query: Partial<KpiQuery> = {}) => computeKpi(actor, key, { ...MARCH, ...query });
const values = (result: KpiResult) => result.rows.map((row) => [row.orgUnitId, row.value]);
const bySource = (result: KpiResult, pick: (row: KpiResult["rows"][number]) => unknown) =>
  Object.fromEntries(result.rows.map((row) => [row.breakdownId ?? "none", pick(row)]));
const totalOf = (result: KpiResult) => result.rows[0]?.value ?? null;

beforeAll(async () => {
  w = await buildAnalyticsWorld("kpi-engine");
  const { techA1, techA1Other, techB } = w;
  const tA1 = techA1.employeeId as string;
  const tA1o = techA1Other.employeeId as string;
  const tB = techB.employeeId as string;

  // Placements as of the start of the year; Tech B worked in City A until April, then moved to City B (spec 3).
  await withTenant(w.tenantId, async (tx) => {
    await tx.organizationalAssignment.updateMany({ where: { tenantId: w.tenantId }, data: { effectiveFrom: at("2026-01-01T00:00:00Z") } });
    await tx.organizationalAssignment.updateMany({ where: { tenantId: w.tenantId, employeeId: tB }, data: { effectiveFrom: at("2026-04-01T04:00:00Z") } });
    await tx.organizationalAssignment.create({
      data: { tenantId: w.tenantId, employeeId: tB, orgUnitId: w.units.cityA, effectiveFrom: at("2026-01-01T00:00:00Z"), effectiveTo: at("2026-04-01T04:00:00Z") },
    });
  });

  const { cityA, teamA1, cityB, outside } = w.units;
  // J1: completed late on 10 March New York time (02:00 UTC on the 11th); took the recommendation as proposed; 2 visits.
  ids.j1 = await insertJob(w, {
    orgUnitId: cityA,
    createdAt: at("2026-03-02T15:00:00Z"),
    startedAt: at("2026-03-11T01:00:00Z"),
    completedAt: at("2026-03-11T02:00:00Z"),
    currentVisitNumber: 2,
    lead: { employeeId: tA1, assignedAt: at("2026-03-02T15:30:00Z"), method: "RECOMMENDATION_APPROVED" },
  });
  ids.j2 = await insertJob(w, {
    orgUnitId: teamA1,
    createdAt: at("2026-03-03T15:00:00Z"),
    startedAt: at("2026-03-12T13:00:00Z"),
    completedAt: at("2026-03-12T15:00:00Z"),
    lead: { employeeId: tA1o, assignedAt: at("2026-03-03T17:00:00Z") },
  });
  ids.j3 = await insertJob(w, { orgUnitId: cityB, createdAt: at("2026-03-04T15:00:00Z"), status: "CANCELLED" });
  ids.j4 = await insertJob(w, {
    orgUnitId: outside,
    createdAt: at("2026-03-05T15:00:00Z"),
    completedAt: at("2026-03-15T15:00:00Z"),
    lead: { employeeId: tA1, assignedAt: at("2026-03-05T19:00:00Z"), method: "OVERRIDE" },
  });
  ids.j5 = await insertJob(w, {
    orgUnitId: cityA,
    createdAt: at("2026-03-06T15:00:00Z"),
    completedAt: at("2026-03-15T15:00:00Z"),
    lead: { employeeId: tB, assignedAt: at("2026-03-06T16:00:00Z") },
  });
  ids.j6 = await insertJob(w, { orgUnitId: cityA, createdAt: at("2026-02-20T15:00:00Z"), completedAt: at("2026-03-20T15:00:00Z") });
  ids.j7 = await insertJob(w, { orgUnitId: cityB, createdAt: at("2026-03-07T15:00:00Z"), status: "PENDING_ASSIGNMENT" });
  ids.j8 = await insertJob(w, { orgUnitId: outside, createdAt: at("2026-03-08T15:00:00Z") });

  await withTenant(w.tenantId, async (tx) => {
    const tenantId = w.tenantId;
    const web = await tx.leadSource.create({ data: { tenantId, code: "web", name: "Website", type: "WEBSITE" } });
    const phone = await tx.leadSource.create({ data: { tenantId, code: "phone", name: "Phone", type: "PHONE" } });
    ids.web = web.id;
    ids.phone = phone.id;
    let number = 0;
    const lead = async (orgUnitId: string | null, sourceId: string, createdAt: string, status: "NEW" | "CONVERTED" | "LOST" | "DUPLICATE" = "NEW", contactAfterMinutes?: number) => {
      const row = await tx.lead.create({ data: { tenantId, number: (number += 1), orgUnitId, sourceId, status, createdAt: at(createdAt) } });
      if (contactAfterMinutes !== undefined) {
        await tx.leadInteraction.create({
          data: { tenantId, leadId: row.id, kind: "CONTACT_ATTEMPT", direction: "OUTBOUND", channel: "PHONE", outcome: "REACHED", occurredAt: new Date(at(createdAt).getTime() + contactAfterMinutes * 60_000) },
        });
      }
      return row.id;
    };
    await lead(cityA, web.id, "2026-03-02T15:00:00Z", "CONVERTED", 10);
    await lead(cityA, web.id, "2026-03-03T15:00:00Z", "NEW", 30);
    await lead(cityB, phone.id, "2026-03-04T15:00:00Z", "LOST");
    await lead(cityA, web.id, "2026-03-05T15:00:00Z", "DUPLICATE", 1);
    await lead(outside, phone.id, "2026-03-06T15:00:00Z", "CONVERTED");
    await lead(null, web.id, "2026-03-07T15:00:00Z");

    let caseNumber = 0;
    const recoveryCase = async (fields: Record<string, unknown>) => {
      const outcome = await tx.jobOutcome.create({ data: { tenantId, jobId: ids.j1, visitNumber: caseNumber + 10, outcome: "NOT_SOLD", lostReasonId: w.lostReasonId } });
      await tx.leadRecoveryCase.create({
        data: { tenantId, number: (caseNumber += 1), jobOutcomeId: outcome.id, jobId: ids.j1, customerId: w.customerId, orgUnitId: cityA, outcomeAt: at("2026-03-10T15:00:00Z"), presenceReason: "not_evaluated", ...fields },
      });
    };
    await recoveryCase({ status: "RECOVERED", recoveredAt: at("2026-03-20T15:00:00Z"), recoveredAmountMinor: 5000n, estimatedValueMinor: 9000n });
    await recoveryCase({ status: "NOT_RECOVERED", closedAt: at("2026-03-21T15:00:00Z"), estimatedValueMinor: 700n });
    await recoveryCase({ status: "CONTACTING", estimatedValueMinor: 3000n });
    await recoveryCase({ status: "CONTACTING", estimatedValueMinor: 100n, currency: "EUR" });
  });
});

afterAll(disconnect);

describe("grouping and periods", () => {
  it("counts every completed job tenant-wide and rolls units up to their city", async () => {
    expect(totalOf(await run(w.ceo.actor, "completed_jobs"))).toBe(5);
    const byCity = await run(w.ceo.actor, "completed_jobs", { groupBy: "CITY" });
    // Team A1 rolls up to City A; Region X has no city, so its job has no city group (null).
    expect(values(byCity)).toEqual([["", 1], [w.units.cityA, 4]].map(([id, value]) => [id === "" ? null : id, value]));
  });

  it("buckets by the local day in the tenant time zone", async () => {
    const byDay = await run(w.ceo.actor, "completed_jobs", { period: "DAY" });
    expect(byDay.timeZone).toBe("America/New_York");
    expect(byDay.rows.map((row) => [row.periodStart, row.value])).toEqual([
      ["2026-03-10", 1],
      ["2026-03-12", 1],
      ["2026-03-15", 2],
      ["2026-03-20", 1],
    ]);
    expect(byDay.rows[0].recordIds).toEqual([ids.j1]);
  });

  it("narrows to a requested unit and its descendants", async () => {
    expect(totalOf(await run(w.ceo.actor, "completed_jobs", { orgUnitId: w.units.cityA }))).toBe(4);
  });

  it("returns rates with numerator and denominator", async () => {
    expect((await run(w.ceo.actor, "cancellation_rate")).rows[0]).toMatchObject({ numerator: 1, denominator: 7 });
    expect((await run(w.ceo.actor, "revisit_rate")).rows[0]).toMatchObject({ numerator: 1, denominator: 4, value: 0.25 });
  });

  it("gives median durations in seconds with the sample count", async () => {
    // 30 min, 2 h, 4 h, 1 h -> median 1.5 h.
    expect((await run(w.ceo.actor, "time_to_assignment")).rows[0]).toMatchObject({ value: 5400, sampleCount: 4 });
    expect((await run(w.ceo.actor, "job_duration")).rows[0]).toMatchObject({ value: 5400, sampleCount: 2 });
  });

  it("counts unassigned jobs as a snapshot that ignores the range", async () => {
    const result = await computeKpi(w.ceo.actor, "unassigned_jobs", { period: "TOTAL", groupBy: "TENANT" });
    expect(result).toMatchObject({ period: null, from: null });
    expect(result.rows[0]).toMatchObject({ periodStart: null, value: 2 });
    expect(result.rows[0].recordIds.sort()).toEqual([ids.j7, ids.j8].sort());
  });
});

describe("attribution", () => {
  it("attributes jobs per employee to the placement effective at completion, never today's (spec 3)", async () => {
    const result = await run(w.ceo.actor, "jobs_per_employee", { groupBy: "CITY" });
    // Tech B led J5 while placed in City A (moved to City B in April): no City B row. 4 jobs by 3 technicians.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ orgUnitId: w.units.cityA, numerator: 4, denominator: 3 });
  });

  it("leaves out jobs outside the viewer's scope even when the technician's unit is inside", async () => {
    const result = await run(w.cityManagerA.actor, "jobs_per_employee");
    expect(result.rows[0]).toMatchObject({ numerator: 3, denominator: 3, value: 1 });
  });
});

describe("access", () => {
  it("limits a city manager to their unit, and a requested unit outside it yields nothing", async () => {
    expect(totalOf(await run(w.cityManagerA.actor, "completed_jobs"))).toBe(4);
    expect((await run(w.cityManagerA.actor, "completed_jobs", { orgUnitId: w.units.cityB })).rows).toEqual([]);
    expect((await run(w.cityManagerB.actor, "cancellation_rate")).rows[0]).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it("lets the dispatcher compute exactly the dispatch_kpis set in their scope", async () => {
    expect((await run(w.dispatcher.actor, "time_to_assignment")).rows[0]).toMatchObject({ value: 3600, sampleCount: 3 });
    expect((await run(w.dispatcher.actor, "dispatch_recommendation_acceptance_rate")).rows[0]).toMatchObject({ numerator: 1, denominator: 3 });
    expect(totalOf(await computeKpi(w.dispatcher.actor, "unassigned_jobs", { period: "TOTAL", groupBy: "TENANT" }))).toBe(1);
    await expect(run(w.dispatcher.actor, "completed_jobs")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(w.dispatcher.actor, "lead_volume_by_source")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a technician and audits the denial", async () => {
    await expect(run(w.techA1.actor, "completed_jobs")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const denials = await auditEvents(w.tenantId, "authz.denied");
    expect(denials.some((event) => event.actorUserId === w.techA1.userId)).toBe(true);
  });

  it("gives Finance no operational KPI (spec 26.3)", async () => {
    await expect(run(w.finance.actor, "completed_jobs")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("404s an unknown key and a defined but not yet computed one", async () => {
    await expect(run(w.ceo.actor, "no_such_kpi")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(run(w.ceo.actor, "charged_revenue")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("lead KPIs", () => {
  it("counts leads per source in the lead manager's scope, duplicates excluded", async () => {
    const result = await run(w.leadOps.actor, "lead_volume_by_source");
    expect(bySource(result, (row) => row.value)).toEqual({ [ids.phone]: 1, [ids.web]: 2 });
    const all = await run(w.ceo.actor, "lead_volume_by_source");
    expect(bySource(all, (row) => row.value)).toEqual({ [ids.phone]: 2, [ids.web]: 3 });
  });

  it("gives conversion by source, also to the COO through the executive family", async () => {
    const result = await run(w.coo.actor, "lead_conversion_rate_by_source");
    expect(bySource(result, (row) => [row.numerator, row.denominator])).toEqual({ [ids.phone]: [1, 2], [ids.web]: [1, 3] });
  });

  it("measures lead response time to the first outbound attempt", async () => {
    expect((await run(w.leadOps.actor, "lead_response_time")).rows[0]).toMatchObject({ value: 1200, sampleCount: 2 });
  });

  it("keeps confirmed recovery revenue and estimates apart, per currency (spec 9.7)", async () => {
    expect((await run(w.leadOps.actor, "recovery_rate")).rows[0]).toMatchObject({ numerator: 1, denominator: 2 });
    const confirmed = await run(w.leadOps.actor, "recovery_confirmed_revenue");
    expect(confirmed.estimate).toBe(false);
    expect(confirmed.rows.map((row) => [row.currency, row.value])).toEqual([["USD", 5000n]]);
    const estimated = await run(w.leadOps.actor, "recovery_estimated_value");
    expect(estimated.estimate).toBe(true);
    expect(estimated.rows.map((row) => [row.currency, row.value])).toEqual([["EUR", 100n], ["USD", 3000n]]);
  });
});

describe("blocked KPIs and validation", () => {
  it("returns BLOCKED_ON_SPEC and no value for compensation expense (spec 28.4)", async () => {
    const result = await run(w.finance.actor, "compensation_expense");
    expect(result).toMatchObject({ status: "BLOCKED_ON_SPEC", rows: [], drillDown: null });
    expect(result.blockedReason).toContain("28.4");
    await expect(run(w.dispatcher.actor, "commission_expense")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires a range of at most 366 days for period KPIs", async () => {
    await expect(computeKpi(w.ceo.actor, "completed_jobs", { period: "TOTAL", groupBy: "TENANT" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(run(w.ceo.actor, "completed_jobs", { from: "2025-01-01", to: "2026-03-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(run(w.ceo.actor, "completed_jobs", { from: "2026-03-02", to: "2026-03-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(run(w.ceo.actor, "completed_jobs", { orgUnitId: "nope" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("read client", () => {
  it("reads from REPORTING_DATABASE_URL when set, with the same results", async () => {
    process.env.REPORTING_DATABASE_URL = process.env.DATABASE_URL;
    try {
      expect(totalOf(await run(w.ceo.actor, "completed_jobs"))).toBe(5);
    } finally {
      delete process.env.REPORTING_DATABASE_URL;
    }
  });

  it("is read-only and bound to the tenant (RLS)", async () => {
    await expect(
      withReportingTenant(w.tenantId, (tx) => tx.leadSource.create({ data: { tenantId: w.tenantId, code: "x", name: "X", type: "API" } })),
    ).rejects.toThrow(/read-only/);
    const other = await createTenant("kpi-other");
    expect(await withReportingTenant(other.id, (tx) => tx.job.count({ where: { id: ids.j1 } }))).toBe(0);
    expect(await withReportingTenant(w.tenantId, (tx) => tx.job.count({ where: { id: ids.j1 } }))).toBe(1);
  });
});
