import {
  MAX_KPI_RANGE_DAYS,
  aggregateFacts,
  localDateRange,
  periodStartOf,
  rangeLengthDays,
  rollUpToLevel,
  type KpiGranularity,
  type KpiValueRow,
  type OrgTreeNode,
} from "@/lib/kpi-aggregation";
import { findKpi, type KpiDefinition, type KpiOrgLevel, type KpiUnit } from "@/lib/kpi-catalog";
import { recordAuthzDenial } from "@/server/authz";
import { ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { resolveKpiAccess } from "./access";
import { buildComputeContext, type KpiFactLoader } from "./compute-context";
import { LEAD_LOADERS } from "./lead-facts";
import { OPERATIONAL_LOADERS } from "./operational-facts";
import { withReportingTenant } from "./read-client";
import type { KpiQuery } from "./schemas";

/** Fact loaders per KPI key. A catalog entry without one is defined but not computed yet (Task 3 adds the financial ones). */
const LOADERS: Readonly<Record<string, KpiFactLoader>> = { ...OPERATIONAL_LOADERS, ...LEAD_LOADERS };

/** Whether the engine can compute `key` today. */
export function isKpiComputed(key: string): boolean {
  return Object.hasOwn(LOADERS, key);
}

/** How to fetch the records behind the values with the owning module's API, under the caller's own permissions. */
export interface KpiDrillDown {
  /** The table the `recordIds` of every row belong to. */
  recordType: string;
  /** The anchor column the range applies to (null for SNAPSHOT). */
  anchor: string | null;
  from: string | null;
  to: string | null;
  orgUnitId: string | null;
}

export interface KpiResult {
  key: string;
  status: KpiDefinition["status"];
  unit: KpiUnit;
  estimate: boolean;
  timeZone: string;
  from: string | null;
  to: string | null;
  period: KpiGranularity | null;
  groupBy: KpiOrgLevel;
  /** Empty for BLOCKED_ON_SPEC: never a value (spec 28.4). */
  rows: KpiValueRow[];
  drillDown: KpiDrillDown | null;
  blockedReason?: string;
}

/** The record table each KPI's `recordIds` refer to. */
function recordTypeOf(kpi: KpiDefinition): string {
  if (kpi.key === "dispatch_decision_latency") return "DispatchRecommendation";
  return kpi.sourceRecords[0] ?? "";
}

async function loadOrgTree(tx: TenantTx, tenantId: string): Promise<Map<string, OrgTreeNode>> {
  const units = await tx.orgUnit.findMany({ where: { tenantId }, select: { id: true, parentId: true, type: true } });
  return new Map(units.map((unit) => [unit.id, { parentId: unit.parentId, type: unit.type }]));
}

/** `root` and every unit below it in the tree. */
function subtreeOf(root: string, tree: ReadonlyMap<string, OrgTreeNode>): string[] {
  const children = new Map<string, string[]>();
  for (const [id, node] of tree) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), id]);
  const result: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (result.includes(id)) continue;
    result.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return result;
}

function validatePeriod(kpi: KpiDefinition, query: KpiQuery): { from: string; to: string } | null {
  if (kpi.period.semantics === "SNAPSHOT") return null;
  if (!query.from || !query.to) throw new ValidationError({ message: "This KPI needs a date range (from and to).", field: query.from ? "to" : "from" });
  if (query.from > query.to) throw new ValidationError({ message: "The range must not end before it starts.", field: "to" });
  if (rangeLengthDays(query.from, query.to) > MAX_KPI_RANGE_DAYS) {
    throw new ValidationError({ message: `The range may cover at most ${MAX_KPI_RANGE_DAYS} days.`, field: "to" });
  }
  return { from: query.from, to: query.to };
}

/**
 * Computes one KPI for the viewer (spec 13.2, 13.4): values grouped by period (in the tenant's time zone) and org level, with
 * sample counts and the source record ids behind every row.
 *
 * - Access: the KPI's own permission and field set over the viewer's scope (`resolveKpiAccess`, checked on the PRIMARY), else
 *   403 (audited). An unknown key is 404. The dashboard family permission is the dashboard's check, not this one.
 * - BLOCKED_ON_SPEC KPIs return that status with no rows, never a number.
 * - Data is read through the reporting read client (read-only; a replica when `REPORTING_DATABASE_URL` is set).
 */
export async function computeKpi(actor: Actor, key: string, query: KpiQuery, ctx?: Pick<RequestContext, "correlationId" | "sourceApp">): Promise<KpiResult> {
  const kpi = findKpi(key);
  if (!kpi) throw new NotFoundError({ message: "Unknown KPI." });

  const now = new Date();
  const access = await withTenant(actor.tenantId, (tx) => resolveKpiAccess(tx, actor, kpi, now));
  if (!access.allowed) {
    await recordAuthzDenial(actor, access.permission, ctx, "NO_PERMISSION");
    throw new ForbiddenError();
  }

  const dates = validatePeriod(kpi, query);
  if (!kpi.orgLevels.includes(query.groupBy)) {
    throw new ValidationError({ message: "This KPI cannot be grouped by that level.", field: "groupBy" });
  }
  const snapshot = kpi.period.semantics === "SNAPSHOT";

  const base = {
    key: kpi.key,
    status: kpi.status,
    unit: kpi.unit,
    estimate: kpi.estimate === true,
    from: dates?.from ?? null,
    to: dates?.to ?? null,
    period: snapshot ? null : query.period,
    groupBy: query.groupBy,
  };

  return withReportingTenant(actor.tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { defaultTimeZone: true } });
    const timeZone = tenant.defaultTimeZone;
    if (kpi.status === "BLOCKED_ON_SPEC") {
      return { ...base, timeZone, rows: [], drillDown: null, blockedReason: kpi.blockedReason };
    }
    const loader = LOADERS[kpi.key];
    if (!loader) throw new NotFoundError({ message: "This KPI is defined but not computed yet." });

    const tree = await loadOrgTree(tx, actor.tenantId);
    if (query.orgUnitId && !tree.has(query.orgUnitId)) throw new ValidationError({ message: "Unknown org unit.", field: "orgUnitId" });
    const requestedUnitIds = query.orgUnitId ? subtreeOf(query.orgUnitId, tree) : null;
    const range = dates ? localDateRange(dates.from, dates.to, timeZone) : null;

    const context = buildComputeContext({ tx, tenantId: actor.tenantId, scope: access.scope, requestedUnitIds, range, now });
    const facts = await loader(context);
    const rows = aggregateFacts(facts, kpi.unit, {
      periodOf: (fact) => (dates ? periodStartOf(fact.at, query.period, timeZone, dates.from) : null),
      groupOf: (fact) => rollUpToLevel(fact.orgUnitId, query.groupBy, tree),
      withBreakdown: kpi.breakdown !== undefined,
    });
    return {
      ...base,
      timeZone,
      rows,
      drillDown: { recordType: recordTypeOf(kpi), anchor: snapshot ? null : kpi.period.anchor, from: base.from, to: base.to, orgUnitId: query.orgUnitId ?? null },
    };
  });
}
