import type { ScopeType } from "@prisma/client";
import {
  buildScopeWhere,
  enforceInTx,
  fieldSetsForRow,
  resolveScope,
  withinScope,
  type ResolvedScope,
  type ScopePart,
} from "@/server/authz";
import { ForbiddenError, ValidationError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { getDataset } from "./catalog";
import type { ReportColumn, ReportDataset, ReportWhere } from "./dataset-types";
import { parseFilters, type ReportDefinition } from "./schemas";

/**
 * Turns a report definition into ONE scoped query for ONE caller (spec 13.5, 22.2). The rules, in order:
 *
 * 1. The caller needs the dataset's view permission; only its TENANT / ORG_UNIT / LEGAL_ENTITY grants count (report
 *    datasets have no OWN / ASSIGNED meaning) and set-qualified grants never count (`resolveScope` drops them).
 * 2. A column is visible when some usable grant reveals its field set; requested columns that are not are dropped and
 *    named in `hiddenColumns` (a saved or shared view never widens access). No visible column at all is a 403.
 * 3. Rows come only from grants that reveal (a) at least one visible column and (b) every field set a filter or the
 *    date range reads, so a filter on a column the caller cannot see on a row can never select that row (no oracle).
 * 4. Cells are projected per row: a cell whose field set no grant covering THAT row reveals is null.
 * 5. Everything is intersected with the view's org unit filter, the owner's extra gate and, for an export, the scope
 *    of the dataset's export permission (`alsoWithinPermission`).
 */

const UNIT_SCOPE_TYPES: readonly ScopeType[] = ["TENANT", "ORG_UNIT", "LEGAL_ENTITY"];

/** A resolved scope rebuilt from some of its parts (same totals rule as authz `narrowScopeToFieldSet`). */
function scopeOfParts(parts: ScopePart[]): ResolvedScope {
  const ofType = (type: ScopeType) => parts.filter((part) => part.type === type);
  return {
    tenantWide: ofType("TENANT").length > 0,
    orgUnitIds: [...new Set(ofType("ORG_UNIT").flatMap((part) => part.orgUnitIds))],
    legalEntityIds: [...new Set(ofType("LEGAL_ENTITY").flatMap((part) => part.legalEntityIds))],
    ownEmployeeId: null,
    assignedEmployeeId: null,
    parts,
  };
}

async function unitScope(tx: TenantTx, actor: Actor, permission: string, now: Date): Promise<ResolvedScope> {
  const scope = await resolveScope(tx, actor, permission, now);
  return scopeOfParts(scope.parts.filter((part) => UNIT_SCOPE_TYPES.includes(part.type)));
}

/** Every org unit under `rootId` (itself included), archived ones too: a filter for history, not an access grant. */
async function unitSubtree(tx: TenantTx, tenantId: string, rootId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM "OrgUnit" WHERE "tenantId" = ${tenantId} AND id = ${rootId}
      UNION
      SELECT child.id FROM "OrgUnit" child JOIN tree parent ON child."parentId" = parent.id WHERE child."tenantId" = ${tenantId}
    )
    SELECT id FROM tree`;
  return rows.map((row) => row.id);
}

/** The org unit of a view's scope filter must exist in the tenant. @throws ValidationError */
export async function assertOrgUnitExists(tx: TenantTx, tenantId: string, orgUnitId: string): Promise<void> {
  const unit = await tx.orgUnit.findFirst({ where: { id: orgUnitId, tenantId }, select: { id: true } });
  if (!unit) throw new ValidationError({ message: "The org unit does not exist.", field: "scopeOrgUnitId" });
}

export interface ProjectedRow {
  /** Column key -> raw value (null when empty or not revealed on this row). */
  values: Record<string, unknown>;
  /** Money column key -> the currency of its amount on this row. */
  currencies: Record<string, string>;
}

export interface PreparedReport {
  dataset: ReportDataset;
  /** Requested columns the caller may see, in request order. */
  columns: ReportColumn[];
  /** Requested columns dropped because no grant of the caller reveals them. */
  hiddenColumns: string[];
  /** The effective sort (falls back to `id` when the sort column is not visible on every row). */
  sort: { column: string; direction: "asc" | "desc" };
  where: ReportWhere;
  select: Record<string, unknown>;
  orderBy: Array<Record<string, "asc" | "desc">>;
  /** The row reduced to the visible columns, cells outside the row's field sets set to null; raw values. */
  project: (row: Record<string, unknown>) => ProjectedRow;
}

export interface PrepareOptions {
  sort?: { column: string; direction: "asc" | "desc" };
  /** Export: rows must also be inside the scope of this permission (the dataset's export permission). */
  alsoWithinPermission?: string;
  now?: Date;
}

/**
 * Prepares the scoped query of `definition` for `actor` inside the caller's transaction.
 * @throws ForbiddenError without the dataset's view permission or when no requested column is visible;
 *   ValidationError for unknown columns, bad filters, an unsortable sort column or an unknown org unit.
 */
export async function prepareReport(tx: TenantTx, actor: Actor, definition: ReportDefinition, options: PrepareOptions = {}): Promise<PreparedReport> {
  const now = options.now ?? new Date();
  const dataset = getDataset(definition.datasetKey);
  const columnByKey = new Map(dataset.columns.map((column) => [column.key, column]));
  const unknown = definition.columns.filter((key) => !columnByKey.has(key));
  if (unknown.length > 0) throw new ValidationError({ message: `Unknown columns for this dataset: ${unknown.join(", ")}.`, field: "columns" });
  const filters = parseFilters(dataset, definition.filters);

  await enforceInTx(tx, actor, dataset.viewPermission);
  const scope = await unitScope(tx, actor, dataset.viewPermission, now);
  const revealed = (set: string) => scope.parts.some((part) => part.fieldSets.includes(set));

  const requested = definition.columns.map((key) => columnByKey.get(key) as ReportColumn);
  const columns = requested.filter((column) => revealed(column.fieldSet));
  const hiddenColumns = requested.filter((column) => !revealed(column.fieldSet)).map((column) => column.key);
  if (columns.length === 0) throw new ForbiddenError({ message: "None of the requested columns is visible to you." });

  // Rule 3: the field sets the filters read must be revealed by every grant a row may come through.
  const readSets = new Set<string>();
  for (const key of Object.keys(filters.columns)) readSets.add((columnByKey.get(key) as ReportColumn).fieldSet);
  if (filters.dateFrom || filters.dateTo) readSets.add((columnByKey.get(dataset.dateColumn) as ReportColumn).fieldSet);
  const visibleSets = new Set(columns.map((column) => column.fieldSet));
  const rowParts = scope.parts.filter(
    (part) => [...readSets].every((set) => part.fieldSets.includes(set)) && [...visibleSets].some((set) => part.fieldSets.includes(set)),
  );
  const rowScope = scopeOfParts(rowParts);

  const requestedSort = options.sort ?? dataset.defaultSort;
  const sortColumn = columnByKey.get(requestedSort.column);
  if (!sortColumn || (options.sort && !sortColumn.sortable)) {
    throw new ValidationError({ message: "This column cannot be sorted on.", field: "sort.column" });
  }
  // Ordering by a column the caller cannot read on every row would leak it (the order is an oracle): sort by id instead.
  const sortReadable = rowParts.every((part) => part.fieldSets.includes(sortColumn.fieldSet));
  const sort = sortReadable ? requestedSort : { column: "id", direction: requestedSort.direction };

  const conditions: ReportWhere[] = [{ tenantId: actor.tenantId }];
  for (const [key, value] of Object.entries(filters.columns)) conditions.push({ [key]: Array.isArray(value) ? { in: value } : value });
  if (filters.dateFrom || filters.dateTo) {
    conditions.push({ [dataset.dateColumn]: { ...(filters.dateFrom ? { gte: filters.dateFrom } : {}), ...(filters.dateTo ? { lt: filters.dateTo } : {}) } });
  }
  if (definition.scopeOrgUnitId) {
    await assertOrgUnitExists(tx, actor.tenantId, definition.scopeOrgUnitId);
    conditions.push(dataset.orgUnitFilter(await unitSubtree(tx, actor.tenantId, definition.scopeOrgUnitId)));
  }
  if (dataset.accessGate) conditions.push(await dataset.accessGate(tx, actor, now));
  if (options.alsoWithinPermission) {
    const exportScope = await unitScope(tx, actor, options.alsoWithinPermission, now);
    conditions.push(buildScopeWhere(exportScope, dataset.scopeColumns, now));
  }
  const where = withinScope<ReportWhere>(buildScopeWhere(rowScope, dataset.scopeColumns, now), { AND: conditions });

  // Rule 4: per-row cells only matter when some row-granting part lacks some visible set (e.g. base + financial).
  const uniform = rowParts.every((part) => [...visibleSets].every((set) => part.fieldSets.includes(set)));
  if (!uniform && (!dataset.scopeSelect || !dataset.rowScope)) {
    throw new Error(`Dataset ${dataset.key} mixes field sets but defines no row scope`);
  }
  const select: Record<string, unknown> = { id: true, ...(uniform ? {} : dataset.scopeSelect) };
  for (const column of columns) {
    select[column.key] = true;
    if (column.currencyColumn) select[column.currencyColumn] = true;
  }

  const rowScopeOf = dataset.rowScope;
  const project = (row: Record<string, unknown>): ProjectedRow => {
    const cellSets = uniform || !rowScopeOf ? null : fieldSetsForRow(rowScope, rowScopeOf(row));
    const values: Record<string, unknown> = {};
    const currencies: Record<string, string> = {};
    for (const column of columns) {
      const covered = cellSets === null || cellSets.includes(column.fieldSet);
      values[column.key] = covered ? (row[column.key] ?? null) : null;
      const currency = column.currencyColumn ? row[column.currencyColumn] : undefined;
      if (covered && typeof currency === "string") currencies[column.key] = currency;
    }
    return { values, currencies };
  };

  return {
    dataset,
    columns,
    hiddenColumns,
    sort,
    where,
    select,
    orderBy: sort.column === "id" ? [{ id: sort.direction }] : [{ [sort.column]: sort.direction }, { id: sort.direction }],
    project,
  };
}
