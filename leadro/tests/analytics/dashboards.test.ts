import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listDashboards } from "@/app/api/v1/analytics/dashboards/route";
import { GET as getDashboard } from "@/app/api/v1/analytics/dashboards/[id]/route";
import { DASHBOARD_IDS } from "@/lib/dashboards";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { at, buildAnalyticsWorld, insertJob, type AnalyticsWorld } from "./fixtures";

/** `GET /api/v1/analytics/dashboards` and `GET /api/v1/analytics/dashboards/{id}` (Phase 6 Task 4). */

let w: AnalyticsWorld;
let cookies: Record<string, string>;
const MARCH = { from: "2026-03-01", to: "2026-03-31" };

interface Kpi {
  key: string;
  hidden: boolean;
  status?: string;
  rows?: Array<{ orgUnitId: string | null; value: unknown; sampleCount: number }>;
  sampleCount?: number;
  scope?: { tenantWide: boolean; orgUnitIds: string[] };
  [field: string]: unknown;
}
interface Section {
  key: string;
  groupBy: string;
  period: string;
  kpis: Kpi[];
}

beforeAll(async () => {
  w = await buildAnalyticsWorld("dashboards");
  await insertJob(w, { orgUnitId: w.units.cityA, createdAt: at("2026-03-02T15:00:00Z"), completedAt: at("2026-03-04T15:00:00Z") });
  await insertJob(w, { orgUnitId: w.units.teamA1, createdAt: at("2026-03-03T15:00:00Z"), completedAt: at("2026-03-05T15:00:00Z") });
  await insertJob(w, { orgUnitId: w.units.cityB, createdAt: at("2026-03-06T15:00:00Z"), completedAt: at("2026-03-07T15:00:00Z") });
  cookies = Object.fromEntries(
    await Promise.all(
      (["ceo", "coo", "finance", "dispatcher", "stateManager", "cityManagerA", "leadOps", "techA1"] as const).map(
        async (name) => [name, await sessionCookie(w[name], w.tenantId)] as const,
      ),
    ),
  );
});

afterAll(disconnect);

const dashboard = (cookie: string, id: string, query: Record<string, string> = MARCH) => call(getDashboard, "GET", "/x", { cookie, params: { id }, query });
const section = (json: { data: { sections: Section[] } }, key: string) => json.data.sections.find((entry) => entry.key === key) as Section;
const kpiOf = (entry: Section, key: string) => entry.kpis.find((kpi) => kpi.key === key) as Kpi;

describe("GET /api/v1/analytics/dashboards", () => {
  const ids = async (cookie: string) => ((await call(listDashboards, "GET", "/x", { cookie })).json.data as Array<{ id: string }>).map((entry) => entry.id);

  it("lists the dashboards whose family the caller holds", async () => {
    expect(await ids(cookies.ceo)).toEqual([...DASHBOARD_IDS]);
    expect(await ids(cookies.coo)).toEqual(["executive", "state_regional", "city_branch", "operational"]);
    expect(await ids(cookies.finance)).toEqual(["finance"]);
    expect(await ids(cookies.leadOps)).toEqual(["lead"]);
    // The dispatcher's set-qualified grant opens only the dashboard that accepts the dispatch_kpis set.
    expect(await ids(cookies.dispatcher)).toEqual(["operational"]);
    expect(await ids(cookies.cityManagerA)).toEqual(["state_regional", "city_branch", "operational"]);
    expect(await ids(cookies.techA1)).toEqual([]);
  });

  it("returns the definitions (sections of KPI keys with default grouping and period)", async () => {
    const response = await call(listDashboards, "GET", "/x", { cookie: cookies.finance });
    expect(response.json.data[0]).toMatchObject({ id: "finance", labelKey: "DASHBOARD.FINANCE", permission: "analytics_financial.view", family: "FINANCIAL" });
    expect(response.json.data[0].sections[0]).toMatchObject({ key: "totals", labelKey: "DASHBOARD.SECTION.TOTALS", groupBy: "TENANT", period: "MONTH" });
  });

  it("requires a session", async () => {
    expect((await call(listDashboards, "GET", "/x")).status).toBe(401);
  });
});

describe("GET /api/v1/analytics/dashboards/{id}", () => {
  it("computes every KPI with its metadata for the Owner; BLOCKED_ON_SPEC KPIs carry their status only", async () => {
    const response = await dashboard(cookies.ceo, "executive");
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({ id: "executive", from: "2026-03-01", to: "2026-03-31", timeZone: "America/New_York", orgUnitId: null });
    const company = section(response.json, "company");
    expect(company).toMatchObject({ groupBy: "TENANT", period: "MONTH" });
    const completed = kpiOf(company, "completed_jobs");
    expect(completed).toMatchObject({
      hidden: false,
      status: "ACTIVE",
      labelKey: "KPI.COMPLETED_JOBS",
      definitionRef: "docs/KPI_DEFINITIONS.md#completed_jobs",
      unit: "COUNT",
      estimate: false,
      groupBy: "TENANT",
      period: { semantics: "EVENT_IN_PERIOD", anchor: "Job.completedAt", granularity: "MONTH", from: "2026-03-01", to: "2026-03-31" },
      scope: { tenantWide: true, orgUnitIds: [] },
      sampleCount: 3,
    });
    expect(completed.rows).toEqual([expect.objectContaining({ orgUnitId: null, value: 3 })]);

    const blocked = kpiOf(company, "compensation_expense");
    expect(blocked).toMatchObject({ hidden: false, status: "BLOCKED_ON_SPEC", blockedReason: expect.any(String) });
    expect(blocked).not.toHaveProperty("rows");
    expect(blocked).not.toHaveProperty("sampleCount");

    // State comparison: every job rolls up to State S.
    const states = kpiOf(section(response.json, "state_comparison"), "completed_jobs");
    expect(states.rows).toEqual([expect.objectContaining({ orgUnitId: w.units.state, value: 3 })]);
    expect(kpiOf(company, "recovery_estimated_value")).toMatchObject({ estimate: true });
  });

  it("hides the KPIs the viewer lacks access to, without failing the dashboard", async () => {
    const response = await dashboard(cookies.coo, "executive");
    expect(response.status).toBe(200);
    const company = section(response.json, "company");
    // The COO holds financial_reports.view but not the materials cost set (Phase 6 Task 3).
    expect(kpiOf(company, "charged_revenue")).toMatchObject({ hidden: false, status: "ACTIVE" });
    const grossProfit = kpiOf(company, "gross_profit");
    expect(grossProfit).toEqual({ key: "gross_profit", labelKey: "KPI.GROSS_PROFIT", definitionRef: "docs/KPI_DEFINITIONS.md#gross_profit", unit: "MONEY", hidden: true });
  });

  it("gives the dispatcher the dispatch subset of the operational dashboard and nothing else", async () => {
    const response = await dashboard(cookies.dispatcher, "operational");
    expect(response.status).toBe(200);
    expect(section(response.json, "dispatch").kpis.every((kpi) => !kpi.hidden)).toBe(true);
    expect(section(response.json, "work").kpis.every((kpi) => kpi.hidden)).toBe(true);
    expect(kpiOf(section(response.json, "dispatch"), "unassigned_jobs")).toMatchObject({ period: { semantics: "SNAPSHOT", granularity: null, from: null, to: null } });
    expect((await dashboard(cookies.dispatcher, "state_regional")).status).toBe(403);
    expect((await dashboard(cookies.finance, "executive")).status).toBe(403);
  });

  it("compares org units only inside the viewer's scope", async () => {
    const state = await dashboard(cookies.stateManager, "state_regional");
    const stateRows = kpiOf(section(state.json, "city_comparison"), "completed_jobs").rows ?? [];
    expect(stateRows.map((row) => [row.orgUnitId, row.value]).sort()).toEqual([[w.units.cityA, 2], [w.units.cityB, 1]].sort());

    const city = await dashboard(cookies.cityManagerA, "state_regional");
    expect(city.status).toBe(200);
    const cityKpi = kpiOf(section(city.json, "city_comparison"), "completed_jobs");
    expect(cityKpi.rows?.map((row) => [row.orgUnitId, row.value])).toEqual([[w.units.cityA, 2]]);
    expect(cityKpi.scope?.tenantWide).toBe(false);
    expect(cityKpi.scope?.orgUnitIds).toContain(w.units.cityA);
    expect(cityKpi.scope?.orgUnitIds).not.toContain(w.units.cityB);

    // Narrowing to a unit: inside the scope it applies; outside it is the same 400 as an unknown unit.
    const narrowed = await dashboard(cookies.stateManager, "state_regional", { ...MARCH, orgUnitId: w.units.cityB });
    expect(narrowed.json.data.orgUnitId).toBe(w.units.cityB);
    expect(kpiOf(section(narrowed.json, "overview"), "completed_jobs").sampleCount).toBe(1);
    expect((await dashboard(cookies.cityManagerA, "state_regional", { ...MARCH, orgUnitId: w.units.cityB })).status).toBe(400);
    expect((await dashboard(cookies.cityManagerA, "state_regional", { ...MARCH, orgUnitId: "missing" })).status).toBe(400);
  });

  it("uses the dashboard's default range and section periods, or the request's period for every section", async () => {
    const defaults = await dashboard(cookies.ceo, "operational", {});
    expect(defaults.status).toBe(200);
    const { from, to } = defaults.json.data as { from: string; to: string };
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(6);
    expect(section(defaults.json, "dispatch").period).toBe("DAY");

    const weekly = await dashboard(cookies.ceo, "operational", { ...MARCH, period: "WEEK" });
    expect(weekly.json.data.sections.every((entry: Section) => entry.period === "WEEK")).toBe(true);
  });

  it("answers 404 for an unknown dashboard and 400 for a bad range", async () => {
    expect((await dashboard(cookies.ceo, "nope")).status).toBe(404);
    expect((await dashboard(cookies.ceo, "executive", { from: "2026-03-01" })).status).toBe(400);
    expect((await dashboard(cookies.ceo, "executive", { from: "2026-03-31", to: "2026-03-01" })).status).toBe(400);
    expect((await dashboard(cookies.ceo, "executive", { ...MARCH, groupBy: "CITY" })).status).toBe(400);
    expect((await dashboard(cookies.techA1, "executive")).status).toBe(403);
  });

  it("audits a refused dashboard", async () => {
    await dashboard(cookies.dispatcher, "finance");
    const denial = await withTenant(w.tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { tenantId: w.tenantId, actorUserId: w.dispatcher.userId, action: "authz.denied" }, orderBy: { occurredAt: "desc" } }),
    );
    expect(JSON.stringify(denial)).toContain("analytics_financial.view");
  });
});
