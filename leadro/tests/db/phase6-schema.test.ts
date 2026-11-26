import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { createTenant } from "../helpers";

/**
 * Phase 6 schema (migration 20261127100000_phase6_analytics): tenant isolation of the report tables, composite tenant-safe foreign
 * keys, CHECK constraints, the one-active-name rule of saved views, frozen columns, the append-only export log and the analytics
 * indexes on the aggregated tables. Constraint, index and trigger names asserted here are part of the migration contract.
 */

interface Graph {
  tenantId: string;
  orgUnitId: string;
  ownerUserId: string;
  otherUserId: string;
  roleId: string;
  viewId: string;
  shareId: string;
  exportId: string;
}

const suffix = Math.random().toString(36).slice(2, 7);
const HASH = "a".repeat(64);
let A: Graph;
let B: Graph;

async function buildGraph(label: string): Promise<Graph> {
  const tenant = await createTenant(label);
  const tenantId = tenant.id;
  return withTenant(tenantId, async (tx) => {
    const orgUnit = await tx.orgUnit.create({ data: { tenantId, type: "STATE", name: `State ${label}` } });
    const owner = await tx.user.create({ data: { tenantId, email: `o-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const other = await tx.user.create({ data: { tenantId, email: `u-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const role = await tx.role.create({ data: { tenantId, name: `Analysts ${label}` } });
    const view = await tx.savedReportView.create({
      data: {
        tenantId, ownerId: owner.id, name: "Completed jobs by state", datasetKey: "jobs", columns: ["number", "status", "completedAt"],
        filters: { status: ["COMPLETED"] }, scopeOrgUnitId: orgUnit.id,
      },
    });
    const share = await tx.savedReportViewShare.create({ data: { tenantId, viewId: view.id, roleId: role.id, sharedById: owner.id } });
    const exported = await tx.reportExport.create({
      data: {
        tenantId, actorId: owner.id, datasetKey: "jobs", savedViewId: view.id, filters: { status: ["COMPLETED"] }, filtersHash: HASH,
        scopeOrgUnitId: orgUnit.id, columns: ["number", "status"], status: "COMPLETED", rowCount: 12, rowLimit: 10_000,
      },
    });
    return {
      tenantId, orgUnitId: orgUnit.id, ownerUserId: owner.id, otherUserId: other.id, roleId: role.id, viewId: view.id, shareId: share.id,
      exportId: exported.id,
    };
  });
}

beforeAll(async () => {
  A = await buildGraph("p6a");
  B = await buildGraph("p6b");
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const rejects = (g: Graph, rule: RegExp | string, fn: (tx: TenantTx) => Promise<unknown>) => expect(withTenant(g.tenantId, fn)).rejects.toThrow(rule);
const run = <T>(g: Graph, fn: (tx: TenantTx) => Promise<T>) => withTenant(g.tenantId, fn);

let viewCounter = 0;
/** A valid saved view for graph `g` (unique name); `over` overrides columns. */
const view = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, ownerId: g.ownerUserId, name: `View ${(viewCounter += 1)}`, datasetKey: "leads", columns: ["number"], ...over,
});

/** A valid export row for graph `g`; `over` overrides columns. */
const exportRow = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, actorId: g.ownerUserId, datasetKey: "jobs", filters: {}, filtersHash: HASH, columns: ["number"],
  status: "COMPLETED" as const, rowCount: 1, rowLimit: 100, ...over,
});

describe("tenant isolation of every Phase 6 table", () => {
  const TABLES = ["SavedReportView", "SavedReportViewShare", "ReportExport"];

  it.each(TABLES)("%s: each tenant sees only its own rows, and nothing without a tenant context", async (table) => {
    const own = (g: Graph) =>
      withTenant(g.tenantId, async (tx) => (await tx.$queryRawUnsafe<{ tenantId: string }[]>(`SELECT "tenantId" FROM "${table}"`)).map((r) => r.tenantId));
    expect(new Set(await own(A))).toEqual(new Set([A.tenantId]));
    expect(new Set(await own(B))).toEqual(new Set([B.tenantId]));
    expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`)).toEqual([]);
  });

  it("a tenant cannot insert a Phase 6 row under another tenant's id", async () => {
    await rejects(A, /row-level security/, (tx) => tx.savedReportView.create({ data: view(B) }));
    await rejects(A, /row-level security/, (tx) => tx.reportExport.create({ data: exportRow(B) }));
  });
});

describe("composite foreign keys keep references inside one tenant", () => {
  it("a view cannot name another tenant's owner, org unit or archiver", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.savedReportView.create({ data: view(A, { ownerId: B.ownerUserId }) }));
    await rejects(A, /foreign key/i, (tx) => tx.savedReportView.create({ data: view(A, { scopeOrgUnitId: B.orgUnitId }) }));
    await rejects(A, /foreign key/i, (tx) => tx.savedReportView.create({ data: view(A, { archivedAt: new Date(), archivedById: B.ownerUserId }) }));
  });

  it("a share cannot link another tenant's view, role or user", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.savedReportViewShare.create({ data: { tenantId: A.tenantId, viewId: B.viewId, roleId: A.roleId, sharedById: A.ownerUserId } }));
    await rejects(A, /foreign key/i, (tx) => tx.savedReportViewShare.create({ data: { tenantId: A.tenantId, viewId: A.viewId, roleId: B.roleId, sharedById: A.ownerUserId } }));
    await rejects(A, /foreign key/i, (tx) => tx.savedReportViewShare.create({ data: { tenantId: A.tenantId, viewId: A.viewId, roleId: A.roleId, sharedById: B.ownerUserId } }));
  });

  it("an export cannot name another tenant's actor, saved view or org unit", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.reportExport.create({ data: exportRow(A, { actorId: B.ownerUserId }) }));
    await rejects(A, /foreign key/i, (tx) => tx.reportExport.create({ data: exportRow(A, { savedViewId: B.viewId }) }));
    await rejects(A, /foreign key/i, (tx) => tx.reportExport.create({ data: exportRow(A, { scopeOrgUnitId: B.orgUnitId }) }));
  });
});

describe("saved report views", () => {
  it("checks name, dataset key, filters and the archive pair", async () => {
    await rejects(A, "saved_report_view_name_present", (tx) => tx.savedReportView.create({ data: view(A, { name: "   " }) }));
    await rejects(A, "saved_report_view_name_present", (tx) => tx.savedReportView.create({ data: view(A, { name: "x".repeat(121) }) }));
    await rejects(A, "saved_report_view_dataset_key_format", (tx) => tx.savedReportView.create({ data: view(A, { datasetKey: "Jobs List" }) }));
    await rejects(A, "saved_report_view_filters_object", (tx) => tx.savedReportView.create({ data: view(A, { filters: ["COMPLETED"] }) }));
    await rejects(A, "saved_report_view_archived", (tx) => tx.savedReportView.create({ data: view(A, { archivedAt: new Date() }) }));
    await rejects(A, "saved_report_view_archived", (tx) => tx.savedReportView.create({ data: view(A, { archivedById: A.ownerUserId }) }));
  });

  it("has 1-200 distinct, identifier-like columns", async () => {
    for (const columns of [[], ["number", "number"], ["bad column"], ["1st"], Array.from({ length: 201 }, (_, i) => `c${i}`)]) {
      await rejects(A, "saved_report_view_columns_valid", (tx) => tx.savedReportView.create({ data: view(A, { columns }) }));
    }
    await run(A, (tx) => tx.savedReportView.create({ data: view(A, { columns: ["customer.name", "scheduledStartAt", "total_minor"] }) }));
  });

  it("allows one active view per owner and name; an archived name can be reused, another owner may use it", async () => {
    await rejects(A, /saved_report_view_owner_name_active|Unique constraint/, (tx) =>
      tx.savedReportView.create({ data: view(A, { name: "  completed JOBS by state " }) }),
    );
    await run(A, (tx) => tx.savedReportView.create({ data: view(A, { ownerId: A.otherUserId, name: "Completed jobs by state" }) }));
    const archived = await run(A, (tx) => tx.savedReportView.create({ data: view(A, { name: "Reusable" }) }));
    await run(A, (tx) => tx.savedReportView.update({ where: { id: archived.id }, data: { archivedAt: new Date(), archivedById: A.ownerUserId } }));
    await run(A, (tx) => tx.savedReportView.create({ data: view(A, { name: "Reusable" }) }));
  });

  it("keeps owner and dataset; name, columns and filters may change; never deleted", async () => {
    await rejects(A, /immutable/, (tx) => tx.savedReportView.update({ where: { id: A.viewId }, data: { ownerId: A.otherUserId } }));
    await rejects(A, /immutable/, (tx) => tx.savedReportView.update({ where: { id: A.viewId }, data: { datasetKey: "leads" } }));
    await run(A, (tx) =>
      tx.savedReportView.update({ where: { id: A.viewId }, data: { name: "Completed jobs by state", columns: ["number"], filters: { status: ["CLOSED"] } } }),
    );
    await rejects(A, /never deleted/, (tx) => tx.$executeRaw`DELETE FROM "SavedReportView" WHERE "id" = ${A.viewId}`);
  });
});

describe("saved view shares", () => {
  it("shares a view with a role once, never edits a share, and unshares by deleting it", async () => {
    await rejects(A, /Unique constraint/, (tx) =>
      tx.savedReportViewShare.create({ data: { tenantId: A.tenantId, viewId: A.viewId, roleId: A.roleId, sharedById: A.otherUserId } }),
    );
    await rejects(A, /immutable/, (tx) => tx.savedReportViewShare.update({ where: { id: A.shareId }, data: { sharedById: A.otherUserId } }));
    const otherRole = await run(A, (tx) => tx.role.create({ data: { tenantId: A.tenantId, name: `Temp ${suffix}` } }));
    const share = await run(A, (tx) =>
      tx.savedReportViewShare.create({ data: { tenantId: A.tenantId, viewId: A.viewId, roleId: otherRole.id, sharedById: A.ownerUserId } }),
    );
    await run(A, (tx) => tx.savedReportViewShare.delete({ where: { id: share.id } }));
    expect(await run(A, (tx) => tx.savedReportViewShare.count({ where: { id: share.id } }))).toBe(0);
  });
});

describe("report exports", () => {
  it("are append-only: UPDATE, DELETE and TRUNCATE are rejected", async () => {
    await rejects(A, /append-only/, (tx) => tx.reportExport.update({ where: { id: A.exportId }, data: { rowCount: 0 } }));
    await rejects(A, /append-only/, (tx) => tx.reportExport.delete({ where: { id: A.exportId } }));
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "ReportExport"`)).rejects.toThrow(/append-only/);
  });

  it("checks dataset key, filters, hash, columns and the row cap", async () => {
    await rejects(A, "report_export_dataset_key_format", (tx) => tx.reportExport.create({ data: exportRow(A, { datasetKey: "-jobs" }) }));
    await rejects(A, "report_export_filters_object", (tx) => tx.reportExport.create({ data: exportRow(A, { filters: "status=COMPLETED" }) }));
    await rejects(A, "report_export_filters_hash_format", (tx) => tx.reportExport.create({ data: exportRow(A, { filtersHash: "ABC" }) }));
    await rejects(A, "report_export_columns_valid", (tx) => tx.reportExport.create({ data: exportRow(A, { columns: [] }) }));
    await rejects(A, "report_export_row_limit_positive", (tx) => tx.reportExport.create({ data: exportRow(A, { rowLimit: 0 }) }));
  });

  it("records a row count that matches the outcome", async () => {
    const bad = [
      { status: "COMPLETED", rowCount: null },
      { status: "COMPLETED", rowCount: 101 },
      { status: "COMPLETED", rowCount: -1 },
      { status: "REFUSED_TOO_LARGE", rowCount: 100 },
      { status: "REFUSED_TOO_LARGE", rowCount: null },
    ];
    for (const over of bad) {
      await rejects(A, "report_export_row_count_matches_status", (tx) => tx.reportExport.create({ data: exportRow(A, over) }));
    }
    await run(A, (tx) => tx.reportExport.create({ data: exportRow(A, { status: "COMPLETED", rowCount: 0 }) }));
    await run(A, (tx) => tx.reportExport.create({ data: exportRow(A, { status: "REFUSED_TOO_LARGE", rowCount: 250_000 }) }));
  });

  it("records a failure as a stable code, and only for FAILED", async () => {
    await rejects(A, "report_export_failure_code", (tx) => tx.reportExport.create({ data: exportRow(A, { status: "FAILED", rowCount: null }) }));
    await rejects(A, "report_export_failure_code", (tx) => tx.reportExport.create({ data: exportRow(A, { failureCode: "query_timeout" }) }));
    await rejects(A, "report_export_failure_code", (tx) =>
      tx.reportExport.create({ data: exportRow(A, { status: "FAILED", rowCount: null, failureCode: "ERROR: relation does not exist" }) }),
    );
    await run(A, (tx) => tx.reportExport.create({ data: exportRow(A, { status: "FAILED", rowCount: null, failureCode: "query_timeout" }) }));
  });
});

describe("migration contract", () => {
  it("creates the partial unique index, the report tables' indexes and the analytics indexes on aggregated tables", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set(rows.map((r) => r.indexname));
    for (const name of [
      "saved_report_view_owner_name_active", "SavedReportViewShare_tenantId_viewId_roleId_key", "ReportExport_tenantId_createdAt_idx",
      "ReportExport_tenantId_actorId_createdAt_idx", "Job_tenantId_orgUnitId_createdAt_idx", "Job_tenantId_orgUnitId_completedAt_idx",
      "Lead_tenantId_orgUnitId_createdAt_idx", "LeadRecoveryCase_tenantId_orgUnitId_outcomeAt_idx",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("adds the export format and status enums", async () => {
    const values = async (type: string) =>
      (await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT unnest(enum_range(NULL::"${type}"))::text AS v`)).map((r) => r.v);
    expect(await values("ReportExportFormat")).toEqual(["CSV"]);
    expect(await values("ReportExportStatus")).toEqual(["COMPLETED", "REFUSED_TOO_LARGE", "FAILED"]);
  });
});
