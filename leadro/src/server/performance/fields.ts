import type { Prisma } from "@prisma/client";
import { METRIC_KIND_CATALOG, type MetricKind } from "@/lib/performance-formulas";
import { activePlacementWhere } from "@/server/authz";

/**
 * What the performance API returns. Definitions are tenant-level configuration (no sensitive field). Values are projected
 * through `PERFORMANCE_METRIC_VALUE_FIELD_MAP` (authz; all `base`): who may see a value at all is `performance.view` and its
 * scope. Lists carry `evidenceCount` instead of the (up to 10,000) evidence ids; `GET /performance/values/{id}` has them.
 */

export const definitionRowSelect = {
  id: true,
  key: true,
  version: true,
  kind: true,
  dimension: true,
  name: true,
  description: true,
  params: true,
  minSample: true,
  status: true,
  approvalRequestId: true,
  createdById: true,
  submittedAt: true,
  publishedAt: true,
  retiredAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PerformanceMetricDefinitionSelect;
export type DefinitionRow = Prisma.PerformanceMetricDefinitionGetPayload<{ select: typeof definitionRowSelect }>;

/** A definition as the API shows it, with the catalog facts of its kind (evidence table, breakdown). */
export function definitionView(row: DefinitionRow): Record<string, unknown> {
  const spec = METRIC_KIND_CATALOG[row.kind as MetricKind];
  return { ...row, evidenceTable: spec.evidenceTable, numeratorKind: spec.numeratorKind };
}

export const valueRowSelect = (now: Date) =>
  ({
    id: true,
    definitionId: true,
    employeeId: true,
    orgUnitId: true,
    periodStart: true,
    periodEnd: true,
    jobTypeId: true,
    jobCategory: true,
    numerator: true,
    denominator: true,
    sampleSize: true,
    enoughData: true,
    evidenceIds: true,
    computedAt: true,
    computedById: true,
    systemActor: true,
    definition: { select: { key: true, version: true, kind: true, dimension: true, status: true, minSample: true } },
    // The employee's CURRENT placements and employer decide which scope parts cover the row (same as employee records).
    employee: { select: { legalEntityId: true, assignments: { where: activePlacementWhere(now), select: { orgUnitId: true } } } },
  }) satisfies Prisma.PerformanceMetricValueSelect;
export type ValueRow = Prisma.PerformanceMetricValueGetPayload<{ select: ReturnType<typeof valueRowSelect> }>;

/** `YYYY-MM-DD` of a `@db.Date` column (Prisma returns it as UTC midnight). */
export const isoDateOf = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The definition facts shown next to a value (key, version, kind, dimension, definition status, minimum sample) so a client
 * renders "not enough data" and the right label without a second call. Never a combined score.
 */
export function valueDefinitionFacts(row: ValueRow): Record<string, unknown> {
  const spec = METRIC_KIND_CATALOG[row.definition.kind as MetricKind];
  return {
    key: row.definition.key,
    version: row.definition.version,
    kind: row.definition.kind,
    dimension: row.definition.dimension,
    definitionStatus: row.definition.status,
    minSample: row.definition.minSample,
    evidenceTable: spec.evidenceTable,
    numeratorKind: spec.numeratorKind,
  };
}
