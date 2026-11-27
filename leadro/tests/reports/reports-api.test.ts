import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listDatasets } from "@/app/api/v1/reports/datasets/route";
import { POST as runQuery } from "@/app/api/v1/reports/query/route";
import { GET as listViews, POST as createView } from "@/app/api/v1/reports/views/route";
import { GET as getView, PATCH as updateView } from "@/app/api/v1/reports/views/[id]/route";
import { POST as archiveView } from "@/app/api/v1/reports/views/[id]/archive/route";
import { POST as shareView } from "@/app/api/v1/reports/views/[id]/shares/route";
import { DELETE as unshareView } from "@/app/api/v1/reports/views/[id]/shares/[roleId]/route";
import { GET as listExports, POST as exportReport } from "@/app/api/v1/reports/exports/route";
import { nextNumber } from "@/server/core";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";
import { buildPerformanceWorld, type PerformanceWorld } from "../performance/fixtures";

let w: PerformanceWorld;
let ceo: string;
let cityA: string;
let cityB: string;
let finance: string;
let tech: string;
let jobA: string;
let jobB: string;
let otherTenantViewId: string;

const query = (cookie: string, body: Record<string, unknown>) => call(runQuery, "POST", "/x", { cookie, body });
const exportCsv = (cookie: string, body: Record<string, unknown>) => call(exportReport, "POST", "/x", { cookie, body });
const ids = (result: { json: { data: Array<{ id: string }> } }) => result.json.data.map((row) => row.id);

async function makeJob(orgUnitId: string, options: { title: string; quoted: bigint; createdAt: Date }): Promise<string> {
  return withTenant(w.tenantId, async (tx) => {
    const job = await tx.job.create({
      data: {
        tenantId: w.tenantId,
        number: await nextNumber(tx, w.tenantId, "job"),
        customerId: w.customerId,
        serviceAddressId: w.addressId,
        jobTypeId: w.jobTypeId,
        orgUnitId,
        title: options.title,
        estimatedDurationMinutes: 60,
        status: "SCHEDULED",
        quotedAmountMinor: options.quoted,
        currency: "USD",
        createdAt: options.createdAt,
      },
    });
    return job.id;
  });
}

beforeAll(async () => {
  w = await buildPerformanceWorld("reports");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityB = await sessionCookie(w.cityManagerB, w.tenantId);
  finance = await sessionCookie(w.finance, w.tenantId);
  tech = await sessionCookie(w.techA1, w.tenantId);
  jobA = await makeJob(w.units.cityA, { title: '=HYPERLINK("http://evil","x")', quoted: 125000n, createdAt: new Date("2026-03-10T15:00:00Z") });
  jobB = await makeJob(w.units.cityB, { title: "Boiler, annual", quoted: 5n, createdAt: new Date("2026-03-11T15:00:00Z") });

  const other = await buildWorld("reports-other");
  otherTenantViewId = await withTenant(other.tenantId, async (tx) =>
    (await tx.savedReportView.create({ data: { tenantId: other.tenantId, ownerId: other.ceo.userId, name: "Theirs", datasetKey: "jobs", columns: ["id"] } })).id,
  );
});
afterAll(disconnect);

const jobColumns = ["id", "number", "title", "status", "quotedAmountMinor", "currency", "createdAt"];

describe("report datasets", () => {
  it("lists datasets with only the columns the caller may see; no report permission is 403", async () => {
    const owner = await call(listDatasets, "GET", "/x", { cookie: ceo });
    expect(owner.status).toBe(200);
    const ownerJobs = owner.json.data.find((dataset: { key: string }) => dataset.key === "jobs");
    expect(ownerJobs.columns.map((column: { key: string }) => column.key)).toContain("quotedAmountMinor");
    expect(ownerJobs.exportable).toBe(true);

    const manager = await call(listDatasets, "GET", "/x", { cookie: cityA });
    const managerJobs = manager.json.data.find((dataset: { key: string }) => dataset.key === "jobs");
    expect(managerJobs.columns.map((column: { key: string }) => column.key)).not.toContain("quotedAmountMinor");
    expect(managerJobs.exportable).toBe(false);
    const hrDatasets = (await call(listDatasets, "GET", "/x", { cookie: await sessionCookie(w.hr, w.tenantId) })).json.data;
    expect(hrDatasets.map((dataset: { key: string }) => dataset.key)).not.toContain("ledger_entries");

    expect((await call(listDatasets, "GET", "/x", { cookie: tech })).status).toBe(403);
  });
});

describe("report query", () => {
  it("scopes rows to the caller and drops columns their grants do not reveal", async () => {
    const manager = await query(cityA, { datasetKey: "jobs", columns: jobColumns });
    expect(manager.status).toBe(200);
    expect(ids(manager)).toContain(jobA);
    expect(ids(manager)).not.toContain(jobB);
    expect(manager.json.meta.hiddenColumns).toEqual(["quotedAmountMinor", "currency"]);
    expect(manager.json.data[0]).not.toHaveProperty("quotedAmountMinor");

    const owner = await query(ceo, { datasetKey: "jobs", columns: jobColumns, filters: { dateFrom: "2026-03-01T00:00:00Z", dateTo: "2026-04-01T00:00:00Z" } });
    expect(ids(owner)).toEqual([jobB, jobA]);
    expect(owner.json.data[1]).toMatchObject({ quotedAmountMinor: "125000", currency: "USD", createdAt: "2026-03-10T15:00:00.000Z" });
  });

  it("a financial-only grant sees only financial columns, cannot filter on base columns and is not sorted by them", async () => {
    const result = await query(finance, { datasetKey: "jobs", columns: ["number", "quotedAmountMinor"] });
    expect(result.json.meta.hiddenColumns).toEqual(["number"]);
    expect(result.json.meta.sort.column).toBe("id");
    expect(result.json.data.length).toBeGreaterThanOrEqual(2);
    expect(result.json.data.every((row: object) => Object.keys(row).join() === "quotedAmountMinor")).toBe(true);
    const filtered = await query(finance, { datasetKey: "jobs", columns: ["quotedAmountMinor"], filters: { status: ["SCHEDULED"] } });
    expect(filtered.json.data).toEqual([]);
    expect((await query(finance, { datasetKey: "jobs", columns: ["number"] })).status).toBe(403);
  });

  it("projects cells per row: a financial grant on one unit never reveals money of another unit's rows", async () => {
    const person = await createPerson(w.tenantId, "mixed-reader", { withEmployee: false });
    const financialA = await makeRole(w.tenantId, "Financial A", [{ permission: "jobs.view", conditions: { includeFields: ["financial"] } }, { permission: "reports.view" }]);
    const plainB = await makeRole(w.tenantId, "Plain B", [{ permission: "jobs.view" }]);
    await grantTemplate(w.tenantId, person, financialA, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    await grantTemplate(w.tenantId, person, plainB, [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }]);
    const cookie = await sessionCookie(person, w.tenantId);
    const result = await query(cookie, { datasetKey: "jobs", columns: ["id", "quotedAmountMinor"], filters: { dateFrom: "2026-03-01T00:00:00Z", dateTo: "2026-04-01T00:00:00Z" } });
    expect(result.json.meta.hiddenColumns).toEqual([]);
    expect(result.json.data).toEqual([{ id: jobB, quotedAmountMinor: null }, { id: jobA, quotedAmountMinor: "125000" }]);
    // Filtering on a financial column only reads rows whose grant reveals it.
    const byCurrency = await query(cookie, { datasetKey: "jobs", columns: ["id"], filters: { currency: ["USD"], dateFrom: "2026-03-01T00:00:00Z" } });
    expect(ids(byCurrency)).toEqual([jobA]);
  });

  it("pages with a cursor, narrows to one org unit subtree and validates the definition", async () => {
    const window = { dateFrom: "2026-03-01T00:00:00Z", dateTo: "2026-04-01T00:00:00Z" };
    const first = await query(ceo, { datasetKey: "jobs", columns: ["id"], filters: window, limit: 1 });
    expect(first.json.data.length).toBe(1);
    const second = await query(ceo, { datasetKey: "jobs", columns: ["id"], filters: window, limit: 1, cursor: first.json.page.nextCursor });
    expect(ids(second)).toEqual([jobA]);
    expect(ids(await query(ceo, { datasetKey: "jobs", columns: ["id"], scopeOrgUnitId: w.units.state, filters: window }))).toEqual([jobB, jobA]);
    expect(ids(await query(ceo, { datasetKey: "jobs", columns: ["id"], scopeOrgUnitId: w.units.cityB }))).toEqual([jobB]);

    expect((await query(ceo, { datasetKey: "nope", columns: ["id"] })).status).toBe(400);
    expect((await query(ceo, { datasetKey: "jobs", columns: ["salary"] })).status).toBe(400);
    const badFilter = await query(ceo, { datasetKey: "jobs", columns: ["id"], filters: { status: ["NOPE"] } });
    expect(badFilter.status).toBe(400);
    expect(badFilter.json.error.field).toMatch(/^filters\.status/);
    expect((await query(ceo, { datasetKey: "jobs", columns: ["id"], sort: { column: "title", direction: "asc" } })).status).toBe(400);
    expect((await query(ceo, { datasetKey: "jobs", columns: ["id"], scopeOrgUnitId: "missing" })).status).toBe(400);
    expect((await query(tech, { datasetKey: "jobs", columns: ["id"] })).status).toBe(403);
  });
});

describe("saved views", () => {
  it("saves, validates, shares by role, runs with the runner's own scope, unshares and archives", async () => {
    const body = { name: "My jobs", datasetKey: "jobs", columns: ["id", "title", "status"], filters: { status: ["SCHEDULED"] } };
    const created = await call(createView, "POST", "/x", { cookie: cityA, body });
    expect(created.status).toBe(201);
    const viewId = created.json.data.id as string;
    expect((await call(createView, "POST", "/x", { cookie: cityA, body: { ...body, name: " my JOBS " } })).status).toBe(409);
    expect((await call(createView, "POST", "/x", { cookie: cityA, body: { ...body, name: "Money", columns: ["id", "quotedAmountMinor"] } })).status).toBe(403);
    expect((await call(createView, "POST", "/x", { cookie: cityA, body: { ...body, name: "Bad", filters: { color: ["red"] } } })).status).toBe(400);
    expect((await call(createView, "POST", "/x", { cookie: tech, body })).status).toBe(403);
    expect((await auditEvents(w.tenantId, "report_view.create", viewId)).length).toBe(1);

    expect((await call(getView, "GET", "/x", { cookie: cityB, params: { id: viewId } })).status).toBe(404);
    expect((await call(getView, "GET", "/x", { cookie: ceo, params: { id: otherTenantViewId } })).status).toBe(404);
    expect((await call(shareView, "POST", "/x", { cookie: cityA, params: { id: viewId }, body: { roleId: w.roles.CITY_MANAGER } })).status).toBe(403);

    const noJobsRole = await makeRole(w.tenantId, "Report reader", [{ permission: "reports.view" }]);
    const refused = await call(shareView, "POST", "/x", { cookie: ceo, params: { id: viewId }, body: { roleId: noJobsRole } });
    expect(refused.status).toBe(400);
    expect(refused.json.error.field).toBe("roleId");
    const shared = await call(shareView, "POST", "/x", { cookie: ceo, params: { id: viewId }, body: { roleId: w.roles.CITY_MANAGER } });
    expect(shared.status).toBe(201);
    expect(shared.json.data.shares.map((share: { roleId: string }) => share.roleId)).toEqual([w.roles.CITY_MANAGER]);
    expect((await call(shareView, "POST", "/x", { cookie: ceo, params: { id: viewId }, body: { roleId: w.roles.CITY_MANAGER } })).status).toBe(409);

    // City B reads the shared view (without the share list) and runs it with ITS scope: City B's jobs only.
    const asB = await call(getView, "GET", "/x", { cookie: cityB, params: { id: viewId } });
    expect(asB.status).toBe(200);
    expect(asB.json.data.shares).toBeUndefined();
    expect(ids(await call(listViews, "GET", "/x", { cookie: cityB }))).toContain(viewId);
    const runB = await query(cityB, { viewId });
    expect(ids(runB)).toEqual([jobB]);
    expect(runB.json.meta.viewId).toBe(viewId);
    expect((await call(updateView, "PATCH", "/x", { cookie: cityB, params: { id: viewId }, body: { name: "Mine now" } })).status).toBe(403);
    expect((await call(archiveView, "POST", "/x", { cookie: cityB, params: { id: viewId } })).status).toBe(403);

    const unshared = await call(unshareView, "DELETE", "/x", { cookie: ceo, params: { id: viewId, roleId: w.roles.CITY_MANAGER } });
    expect(unshared.status).toBe(204);
    expect((await call(unshareView, "DELETE", "/x", { cookie: ceo, params: { id: viewId, roleId: w.roles.CITY_MANAGER } })).status).toBe(404);
    expect((await query(cityB, { viewId })).status).toBe(404);
    expect((await auditEvents(w.tenantId, "report_view.unshare", viewId)).length).toBe(1);

    const renamed = await call(updateView, "PATCH", "/x", { cookie: cityA, params: { id: viewId }, body: { name: "Scheduled jobs" } });
    expect(renamed.json.data.name).toBe("Scheduled jobs");
    const [updateEvent] = await auditEvents(w.tenantId, "report_view.update", viewId);
    expect(updateEvent.previousValue).toEqual({ name: "My jobs" });

    expect((await call(archiveView, "POST", "/x", { cookie: cityA, params: { id: viewId } })).status).toBe(200);
    expect((await call(archiveView, "POST", "/x", { cookie: cityA, params: { id: viewId } })).status).toBe(409);
    expect(ids(await call(listViews, "GET", "/x", { cookie: cityA }))).not.toContain(viewId);
    expect(ids(await call(listViews, "GET", "/x", { cookie: cityA, query: { includeArchived: "true" } }))).toContain(viewId);
    await expect(withTenant(w.tenantId, (tx) => tx.savedReportView.delete({ where: { id: viewId } }))).rejects.toThrow();
  });
});

describe("report exports", () => {
  it("exports CSV with escaping, decimal money and tenant-zone dates, logs and audits it", async () => {
    const result = await exportCsv(ceo, { datasetKey: "jobs", columns: ["id", "title", "quotedAmountMinor", "currency", "createdAt"], scopeOrgUnitId: w.units.state, filters: { dateFrom: "2026-03-01T00:00:00Z" } });
    expect(result.status).toBe(201);
    const { content, contentType, fileName } = result.json.data;
    expect(contentType).toBe("text/csv; charset=utf-8");
    expect(fileName).toMatch(/^jobs-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = (content as string).replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,title,quotedAmountMinor,currency,createdAt");
    expect(lines).toContain(`${jobA},"'=HYPERLINK(""http://evil"",""x"")",1250.00,USD,2026-03-10T11:00:00-04:00`);
    expect(lines).toContain(`${jobB},"Boiler, annual",0.05,USD,2026-03-11T11:00:00-04:00`);

    const log = result.json.data.export;
    expect(log).toMatchObject({ status: "COMPLETED", rowCount: 2, rowLimit: 10000, datasetKey: "jobs", scopeOrgUnitId: w.units.state, filtersHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const [event] = await auditEvents(w.tenantId, "report.export", log.id);
    expect(event.newValue).toMatchObject({ datasetKey: "jobs", rowCount: 2, status: "COMPLETED", columns: ["id", "title", "quotedAmountMinor", "currency", "createdAt"] });
  });

  it("reads query and export rows through the reporting read client when REPORTING_DATABASE_URL is set", async () => {
    process.env.REPORTING_DATABASE_URL = process.env.DATABASE_URL;
    try {
      const definition = { datasetKey: "jobs", columns: ["id", "title"], scopeOrgUnitId: w.units.state, filters: { dateFrom: "2026-03-01T00:00:00Z" } };
      expect(ids(await query(cityA, definition))).toEqual([jobA]);
      const exported = await exportCsv(ceo, definition);
      expect(exported.status).toBe(201);
      expect(exported.json.data.export).toMatchObject({ status: "COMPLETED", rowCount: 2 });
    } finally {
      delete process.env.REPORTING_DATABASE_URL;
    }
  });

  it("needs reports.export AND the dataset's export permission; refusals are audited", async () => {
    expect((await exportCsv(cityA, { datasetKey: "jobs", columns: ["id"] })).status).toBe(403);
    const before = (await auditEvents(w.tenantId, "authz.denied")).length;
    expect((await exportCsv(finance, { datasetKey: "jobs", columns: ["quotedAmountMinor"] })).status).toBe(403);
    expect((await auditEvents(w.tenantId, "authz.denied")).length).toBe(before + 1);
    const ledger = await exportCsv(finance, { datasetKey: "ledger_entries", columns: ["id", "amountMinor", "currency"] });
    expect(ledger.status).toBe(201);
    expect(ledger.json.data.export).toMatchObject({ status: "COMPLETED", rowCount: 0 });
  });

  it("refuses an export over the cap with a truthful message and logs REFUSED_TOO_LARGE", async () => {
    await withTenant(w.tenantId, async (tx) => {
      const start = await nextNumber(tx, w.tenantId, "customer");
      await tx.customer.createMany({ data: Array.from({ length: 5_001 }, (_, index) => ({ tenantId: w.tenantId, number: start + 1 + index, name: `Bulk ${index}` })) });
    });
    const refused = await exportCsv(ceo, { datasetKey: "customers", columns: ["id", "name"] });
    expect(refused.status).toBe(400);
    expect(refused.json.error.message).toMatch(/limited to 5000 rows/);
    const log = await call(listExports, "GET", "/x", { cookie: ceo, query: { datasetKey: "customers" } });
    expect(log.json.data[0]).toMatchObject({ status: "REFUSED_TOO_LARGE", rowLimit: 5000, columns: ["id", "name"] });
    expect(log.json.data[0].rowCount).toBeGreaterThan(5000);
  });

  it("the export log is an audit read: auditors see every export, others only their own", async () => {
    const all = await call(listExports, "GET", "/x", { cookie: ceo });
    expect(all.status).toBe(200);
    expect(new Set(all.json.data.map((row: { actorId: string }) => row.actorId))).toEqual(new Set([w.ceo.userId, w.finance.userId]));
    const own = await call(listExports, "GET", "/x", { cookie: finance });
    expect(own.json.data.every((row: { actorId: string }) => row.actorId === w.finance.userId)).toBe(true);
    expect(own.json.data.length).toBeGreaterThan(0);
    expect((await call(listExports, "GET", "/x", { cookie: cityA })).json.data).toEqual([]);
    expect((await call(listExports, "GET", "/x", { cookie: tech })).status).toBe(403);
  });
});
