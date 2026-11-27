import { canInTx, enforceInTx, resolveScope } from "@/server/authz";
import { pageArgs, toPage, type Actor } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { REPORT_DATASETS } from "./catalog";
import type { ReportColumn, ReportDataset } from "./dataset-types";
import { prepareReport, type PreparedReport, type ProjectedRow } from "./prepare";
import type { ReportDefinition, RunReportInput } from "./schemas";
import { definitionOf, loadReadableView } from "./views";

/** Running reports (`reports.view`): the dataset catalog for the caller and the paginated query. */

export interface DatasetColumnView {
  key: string;
  type: ReportColumn["type"];
  fieldSet: string;
  filter: ReportColumn["filter"] | null;
  sortable: boolean;
  enumValues: readonly string[] | null;
  currencyColumn: string | null;
}

export interface DatasetView {
  key: string;
  viewPermission: string;
  exportPermission: string;
  dateColumn: string;
  defaultSort: ReportDataset["defaultSort"];
  maxExportRows: number;
  /** Only the columns some grant of the caller reveals. */
  columns: DatasetColumnView[];
  /** The caller holds `reports.export` and the dataset's export permission (an attempt is still checked row by row). */
  exportable: boolean;
}

/** `GET /reports/datasets`: the datasets whose view permission the caller holds, with the columns they may see. */
export async function listDatasets(actor: Actor): Promise<DatasetView[]> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "reports.view");
    const now = new Date();
    const mayExport = (await canInTx(tx, actor, "reports.export")).allowed;
    const result: DatasetView[] = [];
    for (const dataset of REPORT_DATASETS) {
      const scope = await resolveScope(tx, actor, dataset.viewPermission, now);
      const parts = scope.parts.filter((part) => part.type === "TENANT" || part.type === "ORG_UNIT" || part.type === "LEGAL_ENTITY");
      const columns = dataset.columns.filter((column) => parts.some((part) => part.fieldSets.includes(column.fieldSet)));
      if (columns.length === 0) continue;
      result.push({
        key: dataset.key,
        viewPermission: dataset.viewPermission,
        exportPermission: dataset.exportPermission,
        dateColumn: dataset.dateColumn,
        defaultSort: dataset.defaultSort,
        maxExportRows: dataset.maxExportRows,
        columns: columns.map((column) => ({
          key: column.key,
          type: column.type,
          fieldSet: column.fieldSet,
          filter: column.filter ?? null,
          sortable: column.sortable ?? false,
          enumValues: column.enumValues ?? null,
          currencyColumn: column.currencyColumn ?? null,
        })),
        exportable: mayExport && (await canInTx(tx, actor, dataset.exportPermission)).allowed,
      });
    }
    return result;
  });
}

/** The definition of a run: the saved view's (readable by the caller) or the request's own. */
export async function resolveRunDefinition(tx: TenantTx, actor: Actor, input: RunReportInput): Promise<{ definition: ReportDefinition; viewId: string | null }> {
  if (input.viewId) {
    const { row } = await loadReadableView(tx, actor, input.viewId);
    return { definition: definitionOf(row), viewId: row.id };
  }
  return {
    definition: {
      datasetKey: input.datasetKey as string,
      columns: input.columns as string[],
      filters: input.filters ?? {},
      scopeOrgUnitId: input.scopeOrgUnitId ?? null,
    },
    viewId: null,
  };
}

/** JSON form of a cell: API conventions (money = minor-unit string via `stringifyJson`, instants ISO UTC, dates YYYY-MM-DD). */
function jsonCell(column: ReportColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (column.type === "date" && value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

export interface ReportPage {
  data: Array<Record<string, unknown>>;
  page: { nextCursor: string | null; limit: number };
  meta: { datasetKey: string; viewId: string | null; columns: string[]; hiddenColumns: string[]; sort: PreparedReport["sort"] };
}

/**
 * `POST /reports/query`: one page of the report for the caller, scoped and projected per row (`prepareReport`). Reads
 * only; nothing is audited (exports are). Rows missing from the caller's scope are simply not there.
 */
export async function runReportQuery(actor: Actor, input: RunReportInput): Promise<ReportPage> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "reports.view");
    const { definition, viewId } = await resolveRunDefinition(tx, actor, input);
    const prepared = await prepareReport(tx, actor, definition, { sort: input.sort });
    const rows = (await prepared.dataset.findMany(tx, {
      where: prepared.where,
      select: prepared.select,
      orderBy: prepared.orderBy,
      ...pageArgs({ cursor: input.cursor, limit: input.limit }),
    })) as Array<Record<string, unknown> & { id: string }>;
    const page = toPage(rows, input.limit);
    const data = page.data.map((row) => {
      const projected: ProjectedRow = prepared.project(row);
      return Object.fromEntries(prepared.columns.map((column) => [column.key, jsonCell(column, projected.values[column.key])]));
    });
    return {
      data,
      page: page.page,
      meta: { datasetKey: definition.datasetKey, viewId, columns: prepared.columns.map((column) => column.key), hiddenColumns: prepared.hiddenColumns, sort: prepared.sort },
    };
  });
}
