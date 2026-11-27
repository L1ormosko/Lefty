import { buildScopeWhere, withinScope, type ResolvedScope } from "@/server/authz";
import { ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import type { KpiFact } from "@/lib/kpi-aggregation";

/** Most source rows one KPI request may read; above it the caller must narrow the range or scope (no silent truncation). */
export const MAX_SOURCE_ROWS = 50_000;
/** Ids per `IN (...)` list, well below Postgres' bind-parameter limit. */
const ID_CHUNK = 5_000;

/** Everything a KPI's fact loader needs. Built by the engine; loaders only read, through `tx` (the reporting read client). */
export interface KpiComputeContext {
  tx: TenantTx;
  tenantId: string;
  /** The requested instants [start, end); null for SNAPSHOT KPIs. */
  range: { start: Date; end: Date } | null;
  now: Date;
  /**
   * The where-clause of a model whose `orgUnitId` column carries the record's org unit (Job, Lead, LeadRecoveryCase): the
   * viewer's scope AND the requested org unit filter AND `own`, combined with `withinScope` so none can widen another.
   */
  where<W extends object>(own: W): W;
  /** Whether an org unit is inside the viewer's scope and the requested filter (for attribution units not on the record). */
  unitVisible(orgUnitId: string | null): boolean;
}

/** Loads one KPI's facts. */
export type KpiFactLoader = (context: KpiComputeContext) => Promise<KpiFact[]>;

export function buildComputeContext(input: {
  tx: TenantTx;
  tenantId: string;
  scope: ResolvedScope;
  /** The requested unit and its descendants; null = no filter. */
  requestedUnitIds: string[] | null;
  range: { start: Date; end: Date } | null;
  now: Date;
}): KpiComputeContext {
  const { scope, requestedUnitIds, now } = input;
  // Every KPI record table names its unit `orgUnitId`; a record without a unit only matches a tenant-wide scope.
  const scopeWhere = buildScopeWhere<{ orgUnitId?: { in: string[] } }>(scope, { orgUnit: (ids) => ({ orgUnitId: { in: ids } }) }, now);
  const requestedWhere = requestedUnitIds === null ? {} : { orgUnitId: { in: requestedUnitIds } };
  const scopeUnits = new Set(scope.orgUnitIds);
  const requestedUnits = requestedUnitIds === null ? null : new Set(requestedUnitIds);
  return {
    tx: input.tx,
    tenantId: input.tenantId,
    range: input.range,
    now,
    where: <W extends object>(own: W) => withinScope(withinScope(scopeWhere as W, requestedWhere as W), own),
    unitVisible: (orgUnitId) => {
      if (requestedUnits !== null && (orgUnitId === null || !requestedUnits.has(orgUnitId))) return false;
      return scope.tenantWide || (orgUnitId !== null && scopeUnits.has(orgUnitId));
    },
  };
}

/** The anchor range of a period KPI; loaders of non-SNAPSHOT KPIs always get one (the engine guarantees it). */
export function rangeOf(context: KpiComputeContext): { gte: Date; lt: Date } {
  if (!context.range) throw new Error("A period KPI was computed without a date range");
  return { gte: context.range.start, lt: context.range.end };
}

/** Fails truthfully when a request would read more rows than one synchronous computation allows. */
export function assertWithinRowCap<T>(rows: T[]): T[] {
  if (rows.length > MAX_SOURCE_ROWS) {
    throw new ValidationError({
      message: `This KPI would read more than ${MAX_SOURCE_ROWS} records. Choose a shorter date range or a smaller organizational scope.`,
      field: "from",
    });
  }
  return rows;
}

/** Runs `fetch` over `ids` in chunks and concatenates the results. */
export async function inChunks<T>(ids: readonly string[], fetch: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < ids.length; index += ID_CHUNK) results.push(...(await fetch(ids.slice(index, index + ID_CHUNK))));
  return results;
}
