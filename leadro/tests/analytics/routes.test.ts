import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listKpis } from "@/app/api/v1/analytics/kpis/route";
import { GET as getKpi } from "@/app/api/v1/analytics/kpis/[key]/route";
import { KPI_CATALOG } from "@/lib/kpi-catalog";
import { disconnect } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { at, buildAnalyticsWorld, insertJob, type AnalyticsWorld } from "./fixtures";

/** `GET /api/v1/analytics/kpis` (catalog the caller may see) and `GET /api/v1/analytics/kpis/{key}` (values). */

let w: AnalyticsWorld;
let cookies: Record<string, string>;

beforeAll(async () => {
  w = await buildAnalyticsWorld("kpi-routes");
  await insertJob(w, { orgUnitId: w.units.cityA, createdAt: at("2026-03-02T15:00:00Z"), completedAt: at("2026-03-04T15:00:00Z") });
  cookies = {
    ceo: await sessionCookie(w.ceo, w.tenantId),
    dispatcher: await sessionCookie(w.dispatcher, w.tenantId),
    finance: await sessionCookie(w.finance, w.tenantId),
    techA1: await sessionCookie(w.techA1, w.tenantId),
  };
});

afterAll(disconnect);

const keysOf = (json: { data: Array<{ key: string }> }) => json.data.map((entry) => entry.key).sort();

describe("GET /api/v1/analytics/kpis", () => {
  it("lists the whole catalog for the Owner, with the 13.4 metadata and whether it is computed", async () => {
    const response = await call(listKpis, "GET", "/api/v1/analytics/kpis", { cookie: cookies.ceo });
    expect(response.status).toBe(200);
    expect(response.json.data).toHaveLength(KPI_CATALOG.length);
    const completed = response.json.data.find((entry: { key: string }) => entry.key === "completed_jobs");
    expect(completed).toMatchObject({ family: "OPERATIONAL", unit: "COUNT", status: "ACTIVE", computed: true, dataOwnerRole: "COO" });
    expect(completed.period).toEqual({ semantics: "EVENT_IN_PERIOD", anchor: "Job.completedAt" });
    expect(response.json.data.find((entry: { key: string }) => entry.key === "commission_expense")).toMatchObject({ status: "BLOCKED_ON_SPEC", computed: false });
  });

  it("lists only the dispatch subset for the dispatcher, the financial keys for Finance, nothing for a technician", async () => {
    expect(keysOf((await call(listKpis, "GET", "/x", { cookie: cookies.dispatcher })).json)).toEqual(
      ["dispatch_decision_latency", "dispatch_recommendation_acceptance_rate", "time_to_arrival", "time_to_assignment", "unassigned_jobs"],
    );
    const finance = keysOf((await call(listKpis, "GET", "/x", { cookie: cookies.finance })).json);
    expect(finance).toContain("compensation_expense");
    expect(finance).not.toContain("completed_jobs");
    expect((await call(listKpis, "GET", "/x", { cookie: cookies.techA1 })).json.data).toEqual([]);
  });

  it("requires a session", async () => {
    expect((await call(listKpis, "GET", "/x")).status).toBe(401);
  });
});

describe("GET /api/v1/analytics/kpis/{key}", () => {
  const values = (cookie: string, key: string, query: Record<string, string> = { from: "2026-03-01", to: "2026-03-31" }) =>
    call(getKpi, "GET", "/x", { cookie, params: { key }, query });

  it("returns values with sample counts and drill-down", async () => {
    const response = await values(cookies.ceo, "completed_jobs", { from: "2026-03-01", to: "2026-03-31", period: "MONTH", groupBy: "CITY" });
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({ key: "completed_jobs", unit: "COUNT", period: "MONTH", groupBy: "CITY", timeZone: "America/New_York" });
    expect(response.json.data.rows).toEqual([
      expect.objectContaining({ periodStart: "2026-03-01", orgUnitId: w.units.cityA, value: 1, sampleCount: 1, recordIdsTruncated: false }),
    ]);
    expect(response.json.data.drillDown).toMatchObject({ recordType: "Job", anchor: "Job.completedAt", from: "2026-03-01", to: "2026-03-31" });
  });

  it("answers 403 without the KPI's permission, 404 for an unknown key, 400 for bad input", async () => {
    expect((await values(cookies.dispatcher, "completed_jobs")).status).toBe(403);
    expect((await values(cookies.techA1, "time_to_assignment")).status).toBe(403);
    expect((await values(cookies.ceo, "nope")).status).toBe(404);
    expect((await values(cookies.ceo, "completed_jobs", { from: "2026-03-01" })).status).toBe(400);
    expect((await values(cookies.ceo, "completed_jobs", { from: "2026-03-01", to: "2026-03-31", groupBy: "TEAM" })).status).toBe(400);
    expect((await values(cookies.ceo, "completed_jobs", { from: "2026-03-01", to: "2026-03-31", extra: "x" })).status).toBe(400);
  });

  it("returns BLOCKED_ON_SPEC without a value", async () => {
    const response = await values(cookies.finance, "commission_expense");
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({ status: "BLOCKED_ON_SPEC", rows: [] });
  });
});
