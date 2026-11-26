import type { Prisma } from "@prisma/client";
import {
  buildScopeWhere,
  enforceInTx,
  fieldSetsForRow,
  PERFORMANCE_METRIC_VALUE_FIELD_MAP,
  projectFields,
  projectRows,
  resolveScope,
  withinScope,
  type AccessDecision,
  type ResolvedScope,
  type RowScopeAttributes,
} from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { valueScopeColumns, valueVisibilityWhere } from "./access";
import { isoDateOf, valueDefinitionFacts, valueRowSelect, type ValueRow } from "./fields";
import type { EmployeeValuesQuery, ListValuesQuery } from "./schemas";

/**
 * Reading metric values (spec 10.2, 10.4). Every value is ONE definition (one dimension) for one employee, period and job type /
 * category, with its sample, denominator, `enoughData` and evidence; nothing here adds, averages or ranks values across
 * dimensions or employees (no universal score). Rows are filtered by the caller's `performance.view` scope over the employee
 * IN THE QUERY, plus the publication rule (`valueVisibilityWhere`), and projected per row.
 */

const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);

function rowAttributes(row: ValueRow): RowScopeAttributes {
  return {
    orgUnitIds: row.employee.assignments.map((placement) => placement.orgUnitId),
    legalEntityIds: row.employee.legalEntityId ? [row.employee.legalEntityId] : [],
    ownerEmployeeId: row.employeeId,
  };
}

/** A value as the API shows it: projected stored columns (dates as YYYY-MM-DD) plus the definition facts. */
function valueView(row: ValueRow, projected: Partial<ValueRow>, withEvidence: boolean): Record<string, unknown> {
  const { evidenceIds, periodStart, periodEnd, ...rest } = projected;
  return {
    ...rest,
    ...(periodStart ? { periodStart: isoDateOf(periodStart) } : {}),
    ...(periodEnd ? { periodEnd: isoDateOf(periodEnd) } : {}),
    ...(evidenceIds ? (withEvidence ? { evidenceIds } : { evidenceCount: evidenceIds.length }) : {}),
    ...valueDefinitionFacts(row),
  };
}

function project(rows: ValueRow[], scope: ResolvedScope, withEvidence: boolean): Record<string, unknown>[] {
  const projected = projectRows(rows, scope, PERFORMANCE_METRIC_VALUE_FIELD_MAP, rowAttributes);
  return rows.map((row, index) => valueView(row, projected[index] as Partial<ValueRow>, withEvidence));
}

/**
 * `GET /performance/values`: every stored snapshot the caller may see (history, recomputations included), newest first.
 * Needs `performance.view`; lists carry `evidenceCount`, not the ids.
 * @throws ForbiddenError
 */
export async function listMetricValues(actor: Actor, query: ListValuesQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "performance.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "performance.view", now);
    const filters: Prisma.PerformanceMetricValueWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.definitionId ? { definitionId: query.definitionId } : {}),
      ...(query.key ? { definition: { key: query.key } } : {}),
      ...(query.periodStart ? { periodStart: dateOf(query.periodStart) } : {}),
      ...(query.periodEnd ? { periodEnd: dateOf(query.periodEnd) } : {}),
      ...(query.jobTypeId ? { jobTypeId: query.jobTypeId } : {}),
      ...(query.jobCategory ? { jobCategory: query.jobCategory } : {}),
    };
    const visibility = await valueVisibilityWhere(tx, actor);
    const rows = await tx.performanceMetricValue.findMany({
      where: withinScope(buildScopeWhere(scope, valueScopeColumns, now), { tenantId: actor.tenantId, AND: [visibility, filters] }),
      orderBy: [{ computedAt: "desc" }, { id: "desc" }],
      select: valueRowSelect(now),
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: project(page.data, scope, false), page: page.page };
  });
}

/**
 * `GET /performance/values/{id}`: one value with its evidence ids (the records counted in the denominator, in the kind's
 * `evidenceTable`). 404 when missing, outside scope or not visible (unpublished preview, or the caller's own preview).
 * @throws ForbiddenError, NotFoundError
 */
export async function getMetricValue(actor: Actor, valueId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "performance.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "performance.view", now);
    const visibility = await valueVisibilityWhere(tx, actor);
    const row = await tx.performanceMetricValue.findFirst({
      where: withinScope(buildScopeWhere(scope, valueScopeColumns, now), { tenantId: actor.tenantId, id: valueId, AND: [visibility] }),
      select: valueRowSelect(now),
    });
    if (!row) throw new NotFoundError();
    const projected = projectFields(row, { allowed: true, fieldSets: fieldSetsForRow(scope, rowAttributes(row)) }, PERFORMANCE_METRIC_VALUE_FIELD_MAP);
    return valueView(row, projected as Partial<ValueRow>, true);
  });
}

/** Rows read for one employee's current values (the newest per key wins, so a generous cap keeps the answer complete). */
const MAX_EMPLOYEE_ROWS = 5_000;

/** Values of versions that were ever published (current or retired): what an employee may see about themselves. */
const PUBLISHED_ONLY: Prisma.PerformanceMetricValueWhereInput = { definition: { publishedAt: { not: null } } };

/** The identity of a value series snapshot: definition version, period and breakdown (recomputations share it). */
const snapshotKey = (row: Pick<ValueRow, "definitionId" | "periodStart" | "periodEnd" | "jobTypeId" | "jobCategory">) =>
  JSON.stringify([row.definitionId, isoDateOf(row.periodStart), isoDateOf(row.periodEnd), row.jobTypeId, row.jobCategory]);

/**
 * The CURRENT value (newest `computedAt`) per definition version, period and breakdown of one employee, restricted by
 * `visibility`, sorted by key, newest period first, then breakdown.
 */
async function currentValueRows(
  tx: TenantTx,
  tenantId: string,
  employeeId: string,
  visibility: Prisma.PerformanceMetricValueWhereInput,
  query: EmployeeValuesQuery,
  now: Date,
): Promise<ValueRow[]> {
  const rows = await tx.performanceMetricValue.findMany({
    where: {
      tenantId,
      employeeId,
      AND: [
        visibility,
        {
          ...(query.definitionId ? { definitionId: query.definitionId } : {}),
          ...(query.key ? { definition: { key: query.key } } : {}),
          ...(query.from ? { periodStart: { gte: dateOf(query.from) } } : {}),
          ...(query.to ? { periodEnd: { lte: dateOf(query.to) } } : {}),
        },
      ],
    },
    orderBy: [{ computedAt: "desc" }, { id: "desc" }],
    select: valueRowSelect(now),
    take: MAX_EMPLOYEE_ROWS,
  });
  const seen = new Set<string>();
  const current: ValueRow[] = [];
  for (const row of rows) {
    const key = snapshotKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    if (query.enoughDataOnly && !row.enoughData) continue;
    current.push(row);
  }
  current.sort((a, b) => a.definition.key.localeCompare(b.definition.key) || b.periodStart.getTime() - a.periodStart.getTime() || (a.jobTypeId ?? a.jobCategory ?? "").localeCompare(b.jobTypeId ?? b.jobCategory ?? ""));
  return current;
}

/**
 * `GET /performance/employees/{employeeId}/values`: the CURRENT value (newest `computedAt`) per definition version, period and
 * breakdown for one employee. Needs `performance.view` over the employee (404 outside scope). Each entry stands alone: there
 * is no total, average or rank across them. `options.publishedOnly` (read models, not the API) leaves out previews of
 * versions that were never published.
 * @throws ForbiddenError, NotFoundError
 */
export async function listEmployeeCurrentValues(
  actor: Actor,
  employeeId: string,
  query: EmployeeValuesQuery,
  options: { publishedOnly?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "performance.view", { employeeId });
    const now = new Date();
    const visibility = options.publishedOnly ? PUBLISHED_ONLY : await valueVisibilityWhere(tx, actor);
    const current = await currentValueRows(tx, actor.tenantId, employeeId, visibility, query, now);
    return current.map((row) => valueView(row, projectFields(row, decision, PERFORMANCE_METRIC_VALUE_FIELD_MAP) as Partial<ValueRow>, false));
  });
}

/** Self-service reads are about the caller's own data: every stored column is theirs to see (all `base`). */
const ownData = (): AccessDecision => ({ allowed: true, reason: "GRANTED", via: null, fieldSets: ["base"] });

/**
 * `GET /me/metrics` (self-service, spec 5.11 "approved performance metrics"): the caller's CURRENT values of versions that
 * were published (a RETIRED version's values stay as history; `definitionStatus` tells them apart, and only values of the
 * PUBLISHED version can be challenged). No module permission: filtered on the caller's employee record. Never a preview.
 */
export async function listOwnCurrentValues(actor: Actor, query: EmployeeValuesQuery): Promise<Record<string, unknown>[]> {
  const employeeId = actor.employeeId;
  if (!employeeId) return [];
  return withTenant(actor.tenantId, async (tx) => {
    const current = await currentValueRows(tx, actor.tenantId, employeeId, PUBLISHED_ONLY, query, new Date());
    return current.map((row) => valueView(row, projectFields(row, ownData(), PERFORMANCE_METRIC_VALUE_FIELD_MAP) as Partial<ValueRow>, false));
  });
}

/** `GET /me/metrics/{id}` (self-service): one of the caller's published values with its evidence ids; anything else is a 404. */
export async function getOwnMetricValue(actor: Actor, valueId: string): Promise<Record<string, unknown>> {
  const employeeId = actor.employeeId;
  if (!employeeId) throw new NotFoundError();
  return withTenant(actor.tenantId, async (tx) => {
    const row = await tx.performanceMetricValue.findFirst({
      where: { tenantId: actor.tenantId, id: valueId, employeeId, AND: [PUBLISHED_ONLY] },
      select: valueRowSelect(new Date()),
    });
    if (!row) throw new NotFoundError();
    return valueView(row, projectFields(row, ownData(), PERFORMANCE_METRIC_VALUE_FIELD_MAP) as Partial<ValueRow>, true);
  });
}

/** One comparison group: a definition version, a period and a breakdown (job type, job category, or none). */
export interface PeerSeries {
  definitionId: string;
  periodStart: string;
  periodEnd: string;
  jobTypeId: string | null;
  jobCategory: string | null;
}

/** One employee's current value in a comparison group. */
export interface PeerValue {
  employeeId: string;
  numerator: number;
  denominator: number;
  sampleSize: number;
  enoughData: boolean;
}

/** Upper bound of snapshot rows read for one comparison (many recomputations of a large unit). */
const MAX_PEER_ROWS = 20_000;

/**
 * For read models (the manager development dashboard), not an endpoint: the CURRENT value of every employee in the caller's
 * `performance.view` scope in each comparison group, values of published versions only. Returns one list per entry of
 * `series`, in the same order. The caller turns them into a position (never a combined score); nothing here ranks.
 * @throws ForbiddenError (no `performance.view`)
 */
export async function listPeerCurrentValues(actor: Actor, series: readonly PeerSeries[]): Promise<PeerValue[][]> {
  if (series.length === 0) return [];
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "performance.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "performance.view", now);
    const groups: Prisma.PerformanceMetricValueWhereInput[] = series.map((entry) => ({
      definitionId: entry.definitionId,
      periodStart: dateOf(entry.periodStart),
      periodEnd: dateOf(entry.periodEnd),
      jobTypeId: entry.jobTypeId,
      jobCategory: entry.jobCategory,
    }));
    const rows = await tx.performanceMetricValue.findMany({
      where: withinScope(buildScopeWhere(scope, valueScopeColumns, now), { tenantId: actor.tenantId, AND: [PUBLISHED_ONLY, { OR: groups }] }),
      orderBy: [{ computedAt: "desc" }, { id: "desc" }],
      select: { definitionId: true, employeeId: true, periodStart: true, periodEnd: true, jobTypeId: true, jobCategory: true, numerator: true, denominator: true, sampleSize: true, enoughData: true },
      take: MAX_PEER_ROWS,
    });
    const byGroup = new Map<string, PeerValue[]>();
    const seen = new Set<string>();
    for (const row of rows) {
      const group = snapshotKey(row);
      const perEmployee = `${group}|${row.employeeId}`;
      if (seen.has(perEmployee)) continue;
      seen.add(perEmployee);
      const list = byGroup.get(group) ?? [];
      list.push({ employeeId: row.employeeId, numerator: row.numerator, denominator: row.denominator, sampleSize: row.sampleSize, enoughData: row.enoughData });
      byGroup.set(group, list);
    }
    return series.map((entry) => byGroup.get(snapshotKey({ ...entry, periodStart: dateOf(entry.periodStart), periodEnd: dateOf(entry.periodEnd) })) ?? []);
  });
}

