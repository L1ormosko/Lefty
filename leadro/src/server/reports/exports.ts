import type { Prisma, ReportExport } from "@prisma/client";
import { csvField, filtersHash, formatInstantInZone, formatMinorUnits, toCsvDocument } from "@/lib/report-csv";
import { localIsoDate } from "@/lib/zoned-time";
import { auditContextFields, recordAudit } from "@/server/audit";
import { canInTx, enforceInTx, recordAuthzDenial } from "@/server/authz";
import { AppError, ForbiddenError, InternalError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { getDataset } from "./catalog";
import type { ReportColumn } from "./dataset-types";
import { prepareReport, type ProjectedRow } from "./prepare";
import { resolveRunDefinition } from "./query";
import type { ListExportsQuery, ReportDefinition, RunReportInput } from "./schemas";

/**
 * Synchronous CSV exports (spec 13.5, global constraint "Exports"; DECISIONS "Phase 6 Task 1" contracts).
 *
 *  - Needs `reports.export` AND the dataset's own export permission; rows must lie inside the scopes of both the view
 *    and the export permission, and columns are gated by field sets exactly as for a query (`prepareReport`).
 *  - Counts first. Over the dataset's cap nothing is produced: a REFUSED_TOO_LARGE row is logged and the caller gets a
 *    truthful 400 (there is no worker for large exports yet). A database failure logs FAILED with a stable code.
 *  - Every attempt that reaches the data writes one `ReportExport` row and a `report.export` audit event in the SAME
 *    transaction (who, dataset, view, filters + hash, org unit, columns, row count, cap, status). A refusal by
 *    permission is audited as `report.export` DENIED (no log row: nothing was selected).
 *  - Cells: text is escaped against formula injection; money is a decimal string in major units of its row's currency
 *    (never summed); instants are ISO local time in the tenant's zone with offset; dates are YYYY-MM-DD.
 */

/** Statement budget of one export (milliseconds): protects the primary until reporting moves to a replica / worker. */
const EXPORT_STATEMENT_TIMEOUT_MS = 30_000;
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

export type ExportLogView = Omit<ReportExport, "tenantId">;

export interface ExportResult {
  export: ExportLogView;
  fileName: string;
  contentType: string;
  /** The CSV document (UTF-8 with BOM, CRLF). */
  content: string;
}

const toLogView = ({ tenantId: _tenantId, ...row }: ReportExport): ExportLogView => row;

function csvCell(column: ReportColumn, row: ProjectedRow, zone: string): string {
  const value = row.values[column.key];
  if (value === null || value === undefined) return "";
  switch (column.type) {
    case "instant":
      return csvField(formatInstantInZone(value as Date, zone), false);
    case "date":
      return csvField((value as Date).toISOString().slice(0, 10), false);
    case "money": {
      const currency = row.currencies[column.key];
      // Without its currency an amount cannot be shown truthfully; leave it empty rather than guess.
      return currency ? csvField(formatMinorUnits(value as bigint, currency), false) : "";
    }
    case "integer":
    case "boolean":
      return csvField(String(value), false);
    default:
      // Text, ids, enums and currency codes: anything that came from a person is neutralized.
      return csvField(String(value), true);
  }
}

interface ExportAttempt {
  definition: ReportDefinition;
  viewId: string | null;
  columns: string[];
  rowLimit: number;
}

async function logAttempt(
  tx: TenantTx,
  actor: Actor,
  ctx: RequestContext,
  attempt: ExportAttempt,
  outcome: { status: ReportExport["status"]; rowCount: number | null; failureCode?: string },
): Promise<ReportExport> {
  const { definition } = attempt;
  const row = await tx.reportExport.create({
    data: {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      datasetKey: definition.datasetKey,
      savedViewId: attempt.viewId,
      filters: definition.filters as Prisma.InputJsonValue,
      filtersHash: filtersHash(definition.filters),
      scopeOrgUnitId: definition.scopeOrgUnitId,
      columns: attempt.columns,
      status: outcome.status,
      rowCount: outcome.rowCount,
      rowLimit: attempt.rowLimit,
      failureCode: outcome.failureCode ?? null,
    },
  });
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action: "report.export",
    targetType: "ReportExport",
    targetId: row.id,
    outcome: outcome.status === "COMPLETED" ? "SUCCESS" : "FAILED",
    newValue: {
      datasetKey: row.datasetKey,
      savedViewId: row.savedViewId,
      filters: row.filters,
      filtersHash: row.filtersHash,
      scopeOrgUnitId: row.scopeOrgUnitId,
      columns: row.columns,
      format: row.format,
      status: row.status,
      rowCount: row.rowCount,
      rowLimit: row.rowLimit,
      failureCode: row.failureCode,
    },
  });
  return row;
}

const isStatementTimeout = (error: unknown) => /57014|statement timeout|canceling statement/i.test(String((error as Error)?.message ?? error));

type AttemptOutcome = { kind: "done"; result: ExportResult } | { kind: "refused"; rowCount: number; rowLimit: number; datasetKey: string };

/**
 * `POST /reports/exports`: exports a definition or a saved view as CSV, synchronously and capped.
 * @throws ForbiddenError (no `reports.export` / dataset export permission / no visible column), ValidationError (bad
 *   definition, or over the cap: nothing exported), InternalError when the database fails (logged as FAILED).
 */
export async function exportReport(actor: Actor, ctx: RequestContext, input: RunReportInput): Promise<ExportResult> {
  let attempt: ExportAttempt | null = null;
  let outcome: AttemptOutcome;
  try {
    outcome = await withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "reports.export");
      const { definition, viewId } = await resolveRunDefinition(tx, actor, input);
      const dataset = getDataset(definition.datasetKey);
      if (!(await canInTx(tx, actor, dataset.exportPermission)).allowed) {
        throw new ForbiddenError({ message: `Exporting this dataset needs ${dataset.exportPermission}.` });
      }
      const prepared = await prepareReport(tx, actor, definition, { sort: input.sort, alsoWithinPermission: dataset.exportPermission });
      attempt = { definition, viewId, columns: prepared.columns.map((column) => column.key), rowLimit: dataset.maxExportRows };
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(EXPORT_STATEMENT_TIMEOUT_MS)}, true)`;

      const rowCount = await dataset.count(tx, prepared.where);
      if (rowCount > dataset.maxExportRows) {
        await logAttempt(tx, actor, ctx, attempt, { status: "REFUSED_TOO_LARGE", rowCount });
        return { kind: "refused", rowCount, rowLimit: dataset.maxExportRows, datasetKey: dataset.key } as const;
      }
      const rows = await dataset.findMany(tx, { where: prepared.where, select: prepared.select, orderBy: prepared.orderBy, take: dataset.maxExportRows });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { defaultTimeZone: true } });
      const zone = tenant.defaultTimeZone;
      const lines = rows.map((row) => {
        const projected = prepared.project(row);
        return prepared.columns.map((column) => csvCell(column, projected, zone));
      });
      const content = toCsvDocument(prepared.columns.map((column) => column.key), lines);
      const logged = await logAttempt(tx, actor, ctx, attempt, { status: "COMPLETED", rowCount: rows.length });
      const stamp = localIsoDate(logged.createdAt.getTime(), zone);
      return {
        kind: "done",
        result: { export: toLogView(logged), fileName: `${dataset.key}-${stamp}.csv`, contentType: CSV_CONTENT_TYPE, content },
      } as const;
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      // Who tried to export what is audit-worthy even when refused (spec 13.5, 22.2); the transaction above rolled back.
      await recordAuthzDenial(actor, "reports.export", ctx, "EXPORT_REFUSED");
      throw error;
    }
    const failed: ExportAttempt | null = attempt;
    if (error instanceof AppError || failed === null) throw error;
    const failureCode = isStatementTimeout(error) ? "query_timeout" : "query_failed";
    await withTenant(actor.tenantId, (tx) => logAttempt(tx, actor, ctx, failed, { status: "FAILED", rowCount: null, failureCode }));
    throw new InternalError({ message: "The export failed; it has been logged. Try a narrower export.", cause: error, retryable: true });
  }
  if (outcome.kind === "refused") {
    throw new ValidationError({
      message: `This export has ${outcome.rowCount} rows; a direct export of ${outcome.datasetKey} is limited to ${outcome.rowLimit} rows. Narrow the filters, the date range or the org unit. Nothing was exported.`,
      field: "filters",
    });
  }
  return outcome.result;
}

/**
 * `GET /reports/exports`: the export log, newest first. Reading it is an audit read: `audit.view` (tenant-level, as
 * for the audit log) sees every export; anyone else with `reports.view` sees only their own.
 */
export async function listExports(actor: Actor, query: ListExportsQuery): Promise<Page<ExportLogView>> {
  return withTenant(actor.tenantId, async (tx) => {
    const auditor = (await canInTx(tx, actor, "audit.view", {})).allowed;
    if (!auditor) await enforceInTx(tx, actor, "reports.view");
    const filters: Prisma.ReportExportWhereInput[] = [{ tenantId: actor.tenantId }];
    if (!auditor) filters.push({ actorId: actor.userId });
    if (query.actorId) filters.push({ actorId: query.actorId });
    if (query.datasetKey) filters.push({ datasetKey: query.datasetKey });
    if (query.status) filters.push({ status: query.status });
    const rows = await tx.reportExport.findMany({
      where: { AND: filters },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toLogView), page: page.page };
  });
}
