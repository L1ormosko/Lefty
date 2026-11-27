import { MAX_KPI_RANGE_DAYS, rangeLengthDays, type KpiGranularity, type KpiValueRow } from "@/lib/kpi-aggregation";
import { findKpi, type KpiDefinition, type KpiOrgLevel, type KpiPeriodSemantics, type KpiStatus, type KpiUnit } from "@/lib/kpi-catalog";
import { DASHBOARDS, dashboardKpiKeys, findDashboard, type DashboardDefinition, type DashboardId } from "@/lib/dashboards";
import { addDays, localIsoDate } from "@/lib/zoned-time";
import { recordAuthzDenial, type ResolvedScope } from "@/server/authz";
import { ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { resolveFamilyAccess, resolveKpiAccess, type KpiAccess } from "./access";
import { computeKpi, type KpiDrillDown, type KpiResult } from "./engine";
import type { DashboardQuery } from "./schemas";

/** Where a KPI's formal definition lives (the generated doc's heading anchor is the key). */
const definitionRefOf = (key: string) => `docs/KPI_DEFINITIONS.md#${key}`;

/** A dashboard as `GET /api/v1/analytics/dashboards` lists it: the static definition. */
export type DashboardSummary = DashboardDefinition;

/** What the KPI's figures cover: the viewer's org-unit coverage for THAT KPI (TENANT / ORG_UNIT grants only). */
export interface DashboardKpiScope {
  tenantWide: boolean;
  /** Units covered (descendants included), sorted; empty when tenant-wide. */
  orgUnitIds: string[];
}

interface DashboardKpiBase {
  key: string;
  labelKey: string;
  definitionRef: string;
  unit: KpiUnit;
}

/** A KPI the viewer may not see: no value, no scope, nothing computed (it is not an error: the rest of the dashboard renders). */
export interface HiddenDashboardKpi extends DashboardKpiBase {
  hidden: true;
}

export interface VisibleDashboardKpi extends DashboardKpiBase {
  hidden: false;
  status: KpiStatus;
  estimate: boolean;
  period: { semantics: KpiPeriodSemantics; anchor: string; granularity: KpiGranularity | null; from: string | null; to: string | null };
  groupBy: KpiOrgLevel;
  scope: DashboardKpiScope;
  /** BLOCKED_ON_SPEC only: why there is no number (spec 28.4). */
  blockedReason?: string;
  /** ACTIVE, computed: records behind all rows, and the rows (`KpiValueRow`). */
  sampleCount?: number;
  rows?: KpiValueRow[];
  drillDown?: KpiDrillDown | null;
  /** ACTIVE, not computed because the request was too large for this KPI (truthful message, e.g. the 50,000-record cap). */
  error?: { code: "VALIDATION_FAILED"; message: string };
}

export type DashboardKpi = HiddenDashboardKpi | VisibleDashboardKpi;

export interface DashboardView {
  id: DashboardId;
  labelKey: string;
  family: DashboardDefinition["family"];
  timeZone: string;
  from: string;
  to: string;
  orgUnitId: string | null;
  sections: Array<{ key: string; labelKey: string; groupBy: KpiOrgLevel; period: KpiGranularity; kpis: DashboardKpi[] }>;
}

/** The dashboards whose family the viewer holds (TENANT / ORG_UNIT grant; set-qualified grants per `familySets`). */
export async function listDashboards(actor: Actor): Promise<DashboardSummary[]> {
  const now = new Date();
  return withTenant(actor.tenantId, async (tx) => {
    const allowedByFamily = new Map<string, boolean>();
    const result: DashboardSummary[] = [];
    for (const definition of DASHBOARDS) {
      const profile = `${definition.permission}|${definition.familySets.join(",")}`;
      let allowed = allowedByFamily.get(profile);
      if (allowed === undefined) {
        allowed = (await resolveFamilyAccess(tx, actor, definition.permission, definition.familySets, now)).allowed;
        allowedByFamily.set(profile, allowed);
      }
      if (allowed) result.push(definition);
    }
    return result;
  });
}

function scopeView(scope: ResolvedScope): DashboardKpiScope {
  return { tenantWide: scope.tenantWide, orgUnitIds: scope.tenantWide ? [] : [...scope.orgUnitIds].sort() };
}

/** The requested range, or the dashboard's default (the last N days in the tenant's zone, today included). */
function rangeOf(definition: DashboardDefinition, query: DashboardQuery, timeZone: string): { from: string; to: string } {
  if (!query.from && !query.to) {
    const to = localIsoDate(Date.now(), timeZone);
    return { from: addDays(to, -(definition.defaultRangeDays - 1)), to };
  }
  if (!query.from || !query.to) throw new ValidationError({ message: "Give both from and to, or neither.", field: query.from ? "to" : "from" });
  if (query.from > query.to) throw new ValidationError({ message: "The range must not end before it starts.", field: "to" });
  if (rangeLengthDays(query.from, query.to) > MAX_KPI_RANGE_DAYS) {
    throw new ValidationError({ message: `The range may cover at most ${MAX_KPI_RANGE_DAYS} days.`, field: "to" });
  }
  return { from: query.from, to: query.to };
}

interface Prepared {
  definition: DashboardDefinition;
  timeZone: string;
  range: { from: string; to: string };
  access: Map<string, KpiAccess>;
}

/**
 * Checks the family permission and resolves every KPI's access in ONE primary transaction (revocations apply at once, like
 * the engine). KPIs sharing an access profile are resolved once.
 */
async function prepare(tx: TenantTx, actor: Actor, definition: DashboardDefinition, query: DashboardQuery, now: Date): Promise<Prepared | null> {
  const family = await resolveFamilyAccess(tx, actor, definition.permission, definition.familySets, now);
  if (!family.allowed) return null;

  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { defaultTimeZone: true } });
  const range = rangeOf(definition, query, tenant.defaultTimeZone);
  if (query.orgUnitId) {
    // One answer for "does not exist" and "outside your scope": a dashboard never confirms a unit the viewer cannot see.
    const inScope = family.scope.tenantWide || family.scope.orgUnitIds.includes(query.orgUnitId);
    const exists = inScope && (await tx.orgUnit.findFirst({ where: { id: query.orgUnitId, tenantId: actor.tenantId }, select: { id: true } }));
    if (!exists) throw new ValidationError({ message: "Unknown org unit.", field: "orgUnitId" });
  }

  const byProfile = new Map<string, KpiAccess>();
  const access = new Map<string, KpiAccess>();
  for (const key of dashboardKpiKeys(definition)) {
    const kpi = findKpi(key) as KpiDefinition;
    const profile = JSON.stringify(kpi.access);
    let resolved = byProfile.get(profile);
    if (!resolved) {
      resolved = await resolveKpiAccess(tx, actor, kpi, now);
      byProfile.set(profile, resolved);
    }
    access.set(key, resolved);
  }
  return { definition, timeZone: tenant.defaultTimeZone, range, access };
}

/**
 * One dashboard for the viewer (spec 13.1-13.3): every KPI of every section computed with `computeKpi` over the viewer's own
 * scope, at the section's grouping. KPIs the viewer may not see are `hidden` (no value); BLOCKED_ON_SPEC KPIs carry their
 * status only. Comparisons stay inside the viewer's scope because every value is computed from in-scope records only.
 *
 * Computations are memoised for the request (the same KPI at the same grouping and period is computed once); nothing is
 * cached across requests. KPIs are computed one after another so a dashboard holds at most one reporting connection.
 *
 * @throws NotFoundError (unknown dashboard), ForbiddenError (no family grant; audited), ValidationError (range, org unit).
 */
export async function getDashboard(actor: Actor, id: string, query: DashboardQuery, ctx?: Pick<RequestContext, "correlationId" | "sourceApp">): Promise<DashboardView> {
  const definition = findDashboard(id);
  if (!definition) throw new NotFoundError({ message: "Unknown dashboard." });

  const prepared = await withTenant(actor.tenantId, (tx) => prepare(tx, actor, definition, query, new Date()));
  if (!prepared) {
    await recordAuthzDenial(actor, definition.permission, ctx, "NO_PERMISSION");
    throw new ForbiddenError();
  }

  const memo = new Map<string, Promise<KpiResult>>();
  const compute = (key: string, groupBy: KpiOrgLevel, period: KpiGranularity) => {
    const memoKey = `${key}|${groupBy}|${period}`;
    let result = memo.get(memoKey);
    if (!result) {
      result = computeKpi(actor, key, { ...prepared.range, period, groupBy, orgUnitId: query.orgUnitId }, ctx);
      memo.set(memoKey, result);
    }
    return result;
  };

  const sections: DashboardView["sections"] = [];
  for (const section of definition.sections) {
    const period = query.period ?? section.period;
    const kpis: DashboardKpi[] = [];
    for (const key of section.kpiKeys) {
      kpis.push(await dashboardKpi(findKpi(key) as KpiDefinition, prepared, section.groupBy, period, compute));
    }
    sections.push({ key: section.key, labelKey: section.labelKey, groupBy: section.groupBy, period, kpis });
  }

  return {
    id: definition.id,
    labelKey: definition.labelKey,
    family: definition.family,
    timeZone: prepared.timeZone,
    from: prepared.range.from,
    to: prepared.range.to,
    orgUnitId: query.orgUnitId ?? null,
    sections,
  };
}

async function dashboardKpi(
  kpi: KpiDefinition,
  prepared: Prepared,
  groupBy: KpiOrgLevel,
  period: KpiGranularity,
  compute: (key: string, groupBy: KpiOrgLevel, period: KpiGranularity) => Promise<KpiResult>,
): Promise<DashboardKpi> {
  const base: DashboardKpiBase = { key: kpi.key, labelKey: kpi.labelKey, definitionRef: definitionRefOf(kpi.key), unit: kpi.unit };
  const access = prepared.access.get(kpi.key);
  if (!access?.allowed) return { ...base, hidden: true };

  const snapshot = kpi.period.semantics === "SNAPSHOT";
  const visible: VisibleDashboardKpi = {
    ...base,
    hidden: false,
    status: kpi.status,
    estimate: kpi.estimate === true,
    period: {
      semantics: kpi.period.semantics,
      anchor: kpi.period.anchor,
      granularity: snapshot ? null : period,
      from: snapshot ? null : prepared.range.from,
      to: snapshot ? null : prepared.range.to,
    },
    groupBy,
    scope: scopeView(access.scope),
  };
  if (kpi.status === "BLOCKED_ON_SPEC") return { ...visible, blockedReason: kpi.blockedReason };

  try {
    const result = await compute(kpi.key, groupBy, period);
    const sampleCount = result.rows.reduce((total, row) => total + row.sampleCount, 0);
    return { ...visible, sampleCount, rows: result.rows, drillDown: result.drillDown };
  } catch (error) {
    // A grant revoked between the access check and the computation: hide it (the engine audited the denial).
    if (error instanceof ForbiddenError) return { ...base, hidden: true };
    // Too many source records for this one KPI: say so on the KPI, keep the rest of the dashboard.
    if (error instanceof ValidationError) return { ...visible, error: { code: "VALIDATION_FAILED", message: error.message } };
    throw error;
  }
}
