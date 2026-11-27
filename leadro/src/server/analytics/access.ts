import type { KpiDefinition } from "@/lib/kpi-catalog";
import { narrowScopeToFieldSet, resolveScope, type ResolvedScope } from "@/server/authz";
import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * What a viewer may see of ONE KPI (spec 13.4, 22.2; Phase 6 Task 1 contract "two layers"): the union of the scopes of every
 * qualifying grant. A grant qualifies when it is one of the KPI's permissions, reveals the KPI's field set, and either has no
 * `set` qualifier or is qualified by one of the KPI's sets (`dispatch_kpis`), passed as satisfied sets like `ResourceRef.sets`.
 *
 * A KPI with `requiresAlso` (data a source module guards with a sensitive field set) is visible only where EVERY listed grant
 * reveals its field set too: the scope is the intersection of the coverages (Phase 6 Task 3).
 *
 * KPIs aggregate records of org units, so only TENANT and ORG_UNIT scopes count. OWN, ASSIGNED and LEGAL_ENTITY scopes cover no
 * KPI (fail closed): an aggregate over "my own records" is the Phase 5 self-service read models' job, not a dashboard's.
 */
export interface KpiAccess {
  allowed: boolean;
  /** The permission that qualified (the first one, for diagnostics), or the first catalog permission when none did. */
  permission: string;
  scope: ResolvedScope;
}

/** Org-unit coverage only, rebuilt from the qualifying parts so it can never be wider than those grants. */
function unitCoverage(scopes: ResolvedScope[]): ResolvedScope {
  const parts = scopes.flatMap((scope) => scope.parts).filter((part) => part.type === "TENANT" || part.type === "ORG_UNIT");
  return {
    tenantWide: parts.some((part) => part.type === "TENANT"),
    orgUnitIds: [...new Set(parts.flatMap((part) => part.orgUnitIds))],
    legalEntityIds: [],
    ownEmployeeId: null,
    assignedEmployeeId: null,
    parts,
  };
}

const covers = (scope: ResolvedScope) => scope.tenantWide || scope.orgUnitIds.length > 0;

/** The org units both coverages reach (ids are already expanded with descendants, so a plain set intersection is exact). */
function intersectCoverage(a: ResolvedScope, b: ResolvedScope): ResolvedScope {
  if (a.tenantWide) return b;
  if (b.tenantWide) return a;
  const inB = new Set(b.orgUnitIds);
  const orgUnitIds = a.orgUnitIds.filter((id) => inB.has(id));
  const parts = orgUnitIds.length > 0 ? [{ type: "ORG_UNIT" as const, orgUnitIds, legalEntityIds: [], employeeId: null, fieldSets: [] }] : [];
  return { tenantWide: false, orgUnitIds, legalEntityIds: [], ownEmployeeId: null, assignedEmployeeId: null, parts };
}

async function coverageOf(tx: TenantTx, actor: Actor, permission: string, fieldSet: string, sets: readonly string[], now: Date): Promise<ResolvedScope> {
  const scope = await resolveScope(tx, actor, permission, now, { satisfiedSets: [...sets] });
  return unitCoverage([narrowScopeToFieldSet(scope, fieldSet)]);
}

/** Resolves the viewer's access to `kpi` on the PRIMARY database (`tx` from `withTenant`), as of `now`. */
export async function resolveKpiAccess(tx: TenantTx, actor: Actor, kpi: KpiDefinition, now: Date): Promise<KpiAccess> {
  const qualifying: Array<{ permission: string; scope: ResolvedScope }> = [];
  for (const permission of kpi.access.permissions) {
    const narrowed = await coverageOf(tx, actor, permission, kpi.access.fieldSet, kpi.access.sets, now);
    if (covers(narrowed)) qualifying.push({ permission, scope: narrowed });
  }
  let scope = unitCoverage(qualifying.map((entry) => entry.scope));
  let permission = qualifying[0]?.permission ?? kpi.access.permissions[0];
  for (const requirement of kpi.access.requiresAlso ?? []) {
    if (!covers(scope)) break;
    scope = intersectCoverage(scope, await coverageOf(tx, actor, requirement.permission, requirement.fieldSet, [], now));
    if (!covers(scope)) permission = requirement.permission;
  }
  return { allowed: covers(scope), permission, scope };
}

/**
 * Whether the viewer may open a dashboard of a family (Phase 6 Task 4): a grant of the family permission with a TENANT or
 * ORG_UNIT scope, where a grant qualified by one of `sets` (the Dispatcher's `dispatch_kpis`) counts too. The returned scope is
 * the family coverage (an `orgUnitId` filter must lie inside it); each KPI on the dashboard is still checked on its own.
 */
export async function resolveFamilyAccess(
  tx: TenantTx,
  actor: Actor,
  permission: string,
  sets: readonly string[],
  now: Date,
): Promise<{ allowed: boolean; scope: ResolvedScope }> {
  const scope = await coverageOf(tx, actor, permission, "base", sets, now);
  return { allowed: covers(scope), scope };
}
