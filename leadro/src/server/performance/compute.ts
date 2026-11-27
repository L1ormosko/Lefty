import type { Prisma } from "@prisma/client";
import { aggregateOpportunities, METRIC_KIND_CATALOG, normalizeMetricParams, type MetricKind } from "@/lib/performance-formulas";
import { startOfLocalDay } from "@/lib/zoned-time";
import { activePlacementWhere, buildScopeWhere, enforceInTx, resolveScope, withinScope } from "@/server/authz";
import { recordAudit } from "@/server/audit";
import { InternalError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { employeeComputeScopeColumns } from "./access";
import { loadDefinition, performanceAuditFields } from "./definitions";
import type { DefinitionRow } from "./fields";
import type { ComputeValuesInput } from "./schemas";
import { readOpportunities } from "./sources";

/**
 * Computing a metric definition for a period (spec 10.2): one append-only `PerformanceMetricValue` per employee x job type
 * (or job category; none for TRAINING_PROGRESS) that had at least one opportunity, with numerator, denominator, sample,
 * `enoughData = sampleSize >= minSample` and the ids of the counted records. A recomputation writes new rows; the newest
 * `computedAt` per (definition, employee, period, breakdown) is the current value. Nothing is ever updated or deleted.
 *
 * Values of a DRAFT version are previews (only authors and managers see them, `access.ts`); a RETIRED version is not
 * computed any more.
 */

/** Evidence ids per value (DB CHECK `performance_metric_value_evidence_size`). */
const MAX_EVIDENCE = 10_000;
/** Employees per computation when none are listed (a manager's whole unit). */
const MAX_DEFAULT_EMPLOYEES = 500;

/** Who computes: a person (computedById) or the system (`system:<name>`, a future scheduler). Exactly one (DB CHECK). */
export type ComputationActor = { userId: string } | { systemActor: `system:${string}` };

const writtenValueSelect = {
  id: true,
  employeeId: true,
  orgUnitId: true,
  jobTypeId: true,
  jobCategory: true,
  numerator: true,
  denominator: true,
  sampleSize: true,
  enoughData: true,
  evidenceIds: true,
  computedAt: true,
} satisfies Prisma.PerformanceMetricValueSelect;
export type WrittenValue = Prisma.PerformanceMetricValueGetPayload<{ select: typeof writtenValueSelect }>;

export interface ComputedValuesSummary {
  definitionId: string;
  key: string;
  version: number;
  periodStart: string;
  periodEnd: string;
  employeeCount: number;
  /** The rows written (without evidence ids; read one value for them). */
  values: Array<Record<string, unknown>>;
}

/**
 * Computes `definition` for `employeeIds` over the tenant-local period `[periodStart, periodEnd)` and inserts the values, all
 * inside `tx` (every source record is read in the same transaction). The caller has checked access to every employee.
 * @throws ValidationError when one value would carry more than MAX_EVIDENCE evidence ids (use a shorter period).
 */
export async function computeMetricValuesInTx(
  tx: TenantTx,
  tenantId: string,
  definition: DefinitionRow,
  input: { periodStart: string; periodEnd: string; employeeIds: string[] },
  by: ComputationActor,
  now: Date = new Date(),
): Promise<WrittenValue[]> {
  const kind = definition.kind as MetricKind;
  const normalized = normalizeMetricParams(kind, definition.params as Record<string, unknown>);
  // Stored params were validated when the version was written; a failure here is a programming / data error.
  if (!normalized.ok) throw new InternalError({ message: `Stored params of metric definition ${definition.id} are invalid.` });

  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultTimeZone: true } });
  const window = {
    tenantId,
    employeeIds: input.employeeIds,
    from: new Date(startOfLocalDay(input.periodStart, tenant.defaultTimeZone)),
    to: new Date(startOfLocalDay(input.periodEnd, tenant.defaultTimeZone)),
    fromDate: new Date(`${input.periodStart}T00:00:00Z`),
    toDate: new Date(`${input.periodEnd}T00:00:00Z`),
    now,
  };
  const opportunities = await readOpportunities(tx, kind, normalized.params, window);
  const values = aggregateOpportunities(opportunities, normalized.params.breakdown, definition.minSample, METRIC_KIND_CATALOG[kind].jobBased ? [] : input.employeeIds);
  if (values.some((value) => value.evidenceIds.length > MAX_EVIDENCE)) {
    throw new ValidationError({ message: `A value would count more than ${MAX_EVIDENCE} records; compute a shorter period.`, field: "periodEnd" });
  }

  // orgUnitId snapshot: the employee's PRIMARY placement in effect now (ERD "documented rules").
  const placements = await tx.organizationalAssignment.findMany({
    where: { tenantId, employeeId: { in: input.employeeIds }, kind: "PRIMARY", ...activePlacementWhere(now) },
    orderBy: { effectiveFrom: "desc" },
    select: { employeeId: true, orgUnitId: true },
  });
  const primaryUnit = new Map<string, string>();
  for (const placement of placements) if (!primaryUnit.has(placement.employeeId)) primaryUnit.set(placement.employeeId, placement.orgUnitId);

  const actorColumns = "userId" in by ? { computedById: by.userId, systemActor: null } : { computedById: null, systemActor: by.systemActor };
  const rows: Prisma.PerformanceMetricValueCreateManyInput[] = values.map((value) => ({
    tenantId,
    definitionId: definition.id,
    employeeId: value.employeeId,
    orgUnitId: primaryUnit.get(value.employeeId) ?? null,
    periodStart: window.fromDate,
    periodEnd: window.toDate,
    jobTypeId: value.jobTypeId,
    jobCategory: value.jobCategory,
    numerator: value.numerator,
    denominator: value.denominator,
    sampleSize: value.sampleSize,
    enoughData: value.enoughData,
    evidenceIds: value.evidenceIds,
    computedAt: now,
    ...actorColumns,
  }));
  if (rows.length === 0) return [];
  return tx.performanceMetricValue.createManyAndReturn({ data: rows, select: writtenValueSelect });
}

/**
 * `POST /performance/definitions/{id}/compute`: computes one version for a period. Needs `performance.manage` over every
 * listed employee (404 for one outside the caller's scope, so existence is not leaked); without `employeeIds`, every
 * non-terminated employee in that scope (at most 500). DRAFT (preview), PENDING_APPROVAL and PUBLISHED versions can be
 * computed; RETIRED cannot. One audit event per computation with the ids of the values written.
 * @throws ForbiddenError, NotFoundError, InvalidStateTransitionError (retired), ValidationError (too many employees / records)
 */
export async function computeMetricValues(actor: Actor, ctx: RequestContext, definitionId: string, input: ComputeValuesInput): Promise<ComputedValuesSummary> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "performance.manage");
    const definition = await loadDefinition(tx, actor.tenantId, definitionId);
    if (definition.status === "RETIRED") throw new InvalidStateTransitionError({ message: "This version is retired; compute the current version instead." });

    const now = new Date();
    const scopeWhere = buildScopeWhere(await resolveScope(tx, actor, "performance.manage", now), employeeComputeScopeColumns, now);
    let employeeIds: string[];
    if (input.employeeIds) {
      const requested = [...new Set(input.employeeIds)];
      const visible = await tx.employee.findMany({ where: withinScope(scopeWhere, { tenantId: actor.tenantId, id: { in: requested } }), select: { id: true } });
      if (visible.length !== requested.length) throw new NotFoundError();
      employeeIds = requested;
    } else {
      const inScope = await tx.employee.findMany({
        where: withinScope(scopeWhere, { tenantId: actor.tenantId, status: { not: "TERMINATED" } }),
        select: { id: true },
        orderBy: { id: "asc" },
        take: MAX_DEFAULT_EMPLOYEES + 1,
      });
      if (inScope.length > MAX_DEFAULT_EMPLOYEES) {
        throw new ValidationError({ message: `More than ${MAX_DEFAULT_EMPLOYEES} employees are in your scope; list the employees to compute.`, field: "employeeIds" });
      }
      employeeIds = inScope.map((employee) => employee.id);
    }

    const written = await computeMetricValuesInTx(tx, actor.tenantId, definition, { periodStart: input.periodStart, periodEnd: input.periodEnd, employeeIds }, { userId: actor.userId }, now);
    await recordAudit(tx, {
      ...performanceAuditFields(actor.tenantId, ctx),
      action: "performance_metric_value.compute",
      targetType: "PerformanceMetricDefinition",
      targetId: definitionId,
      newValue: {
        key: definition.key,
        version: definition.version,
        status: definition.status,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        employeeCount: employeeIds.length,
        valueIds: written.map((value) => value.id),
      },
    });
    return {
      definitionId,
      key: definition.key,
      version: definition.version,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      employeeCount: employeeIds.length,
      // Review P5-R4: a version that was never published is a preview, and nobody sees their own preview values (the read
      // endpoints' rule); the caller's row is stored, counted and audited, just not shown to them.
      values: written
        .filter((value) => definition.publishedAt !== null || value.employeeId !== actor.employeeId)
        .map(({ evidenceIds, ...value }) => ({ ...value, evidenceCount: evidenceIds.length })),
    };
  });
}

/**
 * Worker entry point (no scheduler exists yet): computes a PUBLISHED version for the given employees as `system:<name>`,
 * audited with no person. Same rules and same append-only rows as a person's computation.
 * @throws NotFoundError, InvalidStateTransitionError (not PUBLISHED), ValidationError
 */
export async function computeMetricValuesAsSystem(
  tenantId: string,
  definitionId: string,
  input: { periodStart: string; periodEnd: string; employeeIds: string[] },
  systemName: string,
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const definition = await loadDefinition(tx, tenantId, definitionId);
    if (definition.status !== "PUBLISHED") throw new InvalidStateTransitionError({ message: "The system computes published versions only." });
    const written = await computeMetricValuesInTx(tx, tenantId, definition, input, { systemActor: `system:${systemName}` });
    await recordAudit(tx, {
      ...performanceAuditFields(tenantId, null),
      action: "performance_metric_value.compute",
      targetType: "PerformanceMetricDefinition",
      targetId: definitionId,
      newValue: {
        key: definition.key,
        version: definition.version,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        employeeCount: input.employeeIds.length,
        valueIds: written.map((value) => value.id),
        by: `system:${systemName}`,
      },
    });
    return written.length;
  });
}
