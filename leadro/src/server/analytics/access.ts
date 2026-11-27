import type { KpiDefinition } from "@/lib/kpi-catalog";
import { narrowScopeToFieldSet, resolveScope, type ResolvedScope } from "@/server/authz";
import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * What a viewer may see of ONE KPI (spec 13.4, 22.2; Phase 6 Task 1 contract "two layers"): the union of the scopes of every
 * qualifying grant. A grant qualifies when it is one of the KPI's permissions, reveals the KPI's field set, and either has no
 * `set` qualifier or is qualified by one of the KPI's sets (`dispatch_kpis`), passed as satisfied sets like `ResourceRef.sets`.
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

/** Resolves the viewer's access to `kpi` on the PRIMARY database (`tx` from `withTenant`), as of `now`. */
export async function resolveKpiAccess(tx: TenantTx, actor: Actor, kpi: KpiDefinition, now: Date): Promise<KpiAccess> {
  const qualifying: Array<{ permission: string; scope: ResolvedScope }> = [];
  for (const permission of kpi.access.permissions) {
    const scope = await resolveScope(tx, actor, permission, now, { satisfiedSets: [...kpi.access.sets] });
    const narrowed = unitCoverage([narrowScopeToFieldSet(scope, kpi.access.fieldSet)]);
    if (narrowed.tenantWide || narrowed.orgUnitIds.length > 0) qualifying.push({ permission, scope: narrowed });
  }
  const scope = unitCoverage(qualifying.map((entry) => entry.scope));
  return {
    allowed: qualifying.length > 0,
    permission: qualifying[0]?.permission ?? kpi.access.permissions[0],
    scope,
  };
}
