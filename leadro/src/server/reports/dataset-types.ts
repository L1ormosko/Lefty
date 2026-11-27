import type { ScopeColumns } from "@/server/authz";
import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * The shape of one report dataset (spec 13.5). A dataset is a read model over ONE table owned by another module: the
 * reports module never re-decides what is sensitive, it copies each column's field set from that module's field map
 * (`fieldSetIn`) and reuses its scope columns.
 *
 * Prisma model delegates cannot be typed generically, so a dataset talks to its table through `findMany` / `count`
 * closures and where-fragments are plain objects (`ReportWhere`); each dataset file casts to its own Prisma type once.
 */
export type ReportWhere = Record<string, unknown>;

/** How a cell is typed and formatted. `money` is integer minor units with the currency in `currencyColumn`. */
export type ReportColumnType = "id" | "text" | "enum" | "integer" | "boolean" | "instant" | "date" | "money" | "currency";

/** How a column can be filtered: `in` = one of a list of values (enum / id), `boolean` = equals true / false. */
export type ReportFilterKind = "in" | "boolean";

export interface ReportColumn {
  /** The model's scalar field (`quotedAmountMinor`); also the API key, the CSV header and `REPORT.COLUMN.<key>`. */
  key: string;
  type: ReportColumnType;
  /** Field set that protects the column, copied from the owning module's field map (`base`, `financial`, ...). */
  fieldSet: string;
  /** For `money`: the column with the ISO 4217 currency of the amount (always read, never summed across). */
  currencyColumn?: string;
  /** For `enum`: the allowed values (the Prisma enum). */
  enumValues?: readonly string[];
  filter?: ReportFilterKind;
  sortable?: boolean;
}

export interface ReportDataset {
  /** Stable key (`jobs`, `ledger_entries`); also `REPORT.DATASET.<KEY>`. */
  key: string;
  /** Permission to read the rows (`jobs.view`), checked over its scope; the runner's own grants apply every time. */
  viewPermission: string;
  /** The dataset's own export permission (`jobs.export`), needed together with `reports.export`. */
  exportPermission: string;
  /**
   * Where the rows are attributed for data scope: the owner's ORG_UNIT / LEGAL_ENTITY columns only. OWN / ASSIGNED
   * scopes (a technician's own work) do not open report datasets; leaving them out only ever narrows the result.
   */
  scopeColumns: Pick<ScopeColumns<ReportWhere>, "orgUnit" | "legalEntity">;
  /** The view's optional org unit filter (that unit and its descendants), on the same attribution as the scope. */
  orgUnitFilter: (orgUnitIds: string[]) => ReportWhere;
  /** Extra access rule of the owning module that must hold on every row (follow-ups: the target must be viewable). */
  accessGate?: (tx: TenantTx, actor: Actor, now: Date) => Promise<ReportWhere>;
  /** The column `dateFrom` / `dateTo` filter on (half-open range: from inclusive, to exclusive). */
  dateColumn: string;
  defaultSort: { column: string; direction: "asc" | "desc" };
  /** Synchronous export cap: larger exports are refused (no worker yet, global constraint "Exports"). */
  maxExportRows: number;
  columns: readonly ReportColumn[];
  /**
   * Only for datasets whose columns span several field sets (jobs: base + financial): the select fragment and the
   * row's org units / legal entities that decide which field sets cover each row's cells (`fieldSetsForRow`). A
   * single-set dataset needs neither: its rows are already limited to grants covering that set.
   */
  scopeSelect?: Record<string, unknown>;
  rowScope?: (row: Record<string, unknown>) => { orgUnitIds: string[]; legalEntityIds: string[] };
  findMany: (tx: TenantTx, args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  count: (tx: TenantTx, where: ReportWhere) => Promise<number>;
}

/**
 * The field set of `key` in an owning module's field map. Throws at module load when the column is not classified
 * there, so a dataset can never expose a column its owner has not classified (fail closed).
 */
export function fieldSetIn(fieldMap: Record<string, string>, key: string): string {
  const set = Object.hasOwn(fieldMap, key) ? fieldMap[key] : undefined;
  if (set === undefined) throw new Error(`Report column "${key}" is not classified in its owner's field map`);
  return set;
}

/** Columns that a module without a field map exposes: its whole record is guarded by the permission, i.e. `base`. */
export const BASE = "base";

/** Column builder: every column takes its field set from the owner's field map (`null`: the owner has none, all `base`). */
export function columnsFrom(fieldMap: Record<string, string> | null) {
  return (key: string, type: ReportColumnType, extra: Omit<ReportColumn, "key" | "type" | "fieldSet"> = {}): ReportColumn => ({
    key,
    type,
    fieldSet: fieldMap ? fieldSetIn(fieldMap, key) : BASE,
    ...extra,
  });
}

/** Unit attribution through a relation (`{ job: { orgUnitId: ... } }`), for rows scoped by a parent record. */
export function viaRelation(
  relation: string,
  columns: Pick<ScopeColumns<ReportWhere>, "orgUnit" | "legalEntity">,
): Pick<ScopeColumns<ReportWhere>, "orgUnit" | "legalEntity"> {
  const { orgUnit, legalEntity } = columns;
  return {
    orgUnit: orgUnit && ((ids, now) => ({ [relation]: orgUnit(ids, now) })),
    legalEntity: legalEntity && ((ids, now) => ({ [relation]: legalEntity(ids, now) })),
  };
}

/** `rowScope` of a row that carries `orgUnitId` and `orgUnit.legalEntityId` (directly or under `relation`). */
export function unitRowScope(relation?: string): ReportDataset["rowScope"] {
  return (row) => {
    const source = (relation ? row[relation] : row) as { orgUnitId?: string | null; orgUnit?: { legalEntityId: string | null } | null } | null;
    return {
      orgUnitIds: source?.orgUnitId ? [source.orgUnitId] : [],
      legalEntityIds: source?.orgUnit?.legalEntityId ? [source.orgUnit.legalEntityId] : [],
    };
  };
}

/** The select fragment `unitRowScope` reads. */
export function unitScopeSelect(relation?: string): Record<string, unknown> {
  const fragment = { orgUnitId: true, orgUnit: { select: { legalEntityId: true } } };
  return relation ? { [relation]: { select: fragment } } : fragment;
}
