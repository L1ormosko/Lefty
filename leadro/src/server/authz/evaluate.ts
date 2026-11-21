import type { TenantTx } from "@/server/db";
import { grantFieldSets } from "./conditions";
import { expandActiveOrgUnits } from "./org-tree";
import { loadGrants, loadSubjectState, type LoadedGrant, type LoadedScope, type SubjectState } from "./load-grants";
import { resolveResource, type ResolvedResource } from "./resolve-resource";
import type { AccessDecision, AccessReason, AccessSubject, AccessVia, ResourceRef } from "./types";

export interface ScopeEvaluation {
  scope: LoadedScope;
  matched: boolean;
  /** Human-readable explanation for the diagnostic. */
  detail: string;
}

export interface GrantEvaluation {
  grant: LoadedGrant;
  /** False when the grant's conditions rule this access out. */
  conditionMet: boolean;
  scopes: ScopeEvaluation[];
}

export interface AccessEvaluation {
  decision: AccessDecision;
  subject: SubjectState;
  /** Every assignment of the subject whose role holds the permission, active or not. */
  grants: LoadedGrant[];
  /** Evaluation of the ACTIVE grants only. */
  evaluations: GrantEvaluation[];
}

const deny = (reason: AccessReason): AccessDecision => ({ allowed: false, reason, via: null, fieldSets: [] });

function buildVia(grant: LoadedGrant, scope: LoadedScope): AccessVia {
  return {
    roleAssignmentId: grant.roleAssignmentId,
    roleId: grant.roleId,
    roleName: grant.roleName,
    requiresMfa: grant.requiresMfa,
    scopeId: scope.id,
    scopeType: scope.type,
    scopeOrgUnitId: scope.orgUnitId,
    scopeLegalEntityId: scope.legalEntityId,
  };
}

async function matchScope(
  tx: TenantTx,
  tenantId: string,
  scope: LoadedScope,
  resource: ResolvedResource,
  employeeId: string | null,
): Promise<ScopeEvaluation> {
  // A tenant-level record (no org placement) is only reachable with a TENANT scope.
  if (resource.isTenantLevel && scope.type !== "TENANT") {
    return { scope, matched: false, detail: "Tenant-level record: only a tenant-wide scope covers it." };
  }
  switch (scope.type) {
    case "TENANT":
      return { scope, matched: true, detail: "Tenant-wide scope covers every record of the tenant." };
    case "LEGAL_ENTITY": {
      const matched = scope.legalEntityId !== null && resource.legalEntityIds.includes(scope.legalEntityId);
      return {
        scope,
        matched,
        detail: matched ? "Record belongs to the scoped legal entity." : "Record is in a different legal entity.",
      };
    }
    case "ORG_UNIT": {
      if (scope.orgUnitId === null) return { scope, matched: false, detail: "Scope has no org unit." };
      const covered = await expandActiveOrgUnits(tx, tenantId, [scope.orgUnitId], scope.includeDescendants);
      if (covered.length === 0) {
        return { scope, matched: false, detail: "Scoped org unit is archived or missing, so it grants nothing." };
      }
      const matched = resource.orgUnitIds.some((id) => covered.includes(id));
      return {
        scope,
        matched,
        detail: matched
          ? "Record sits in the scoped org unit (or a descendant)."
          : "Record sits outside the scoped org unit.",
      };
    }
    case "OWN": {
      const matched = employeeId !== null && resource.ownerEmployeeId === employeeId;
      return {
        scope,
        matched,
        detail: matched ? "Record belongs to the user's own employee profile." : "Record belongs to someone else.",
      };
    }
    case "ASSIGNED": {
      const matched = employeeId !== null && resource.assignedEmployeeIds.includes(employeeId);
      return {
        scope,
        matched,
        detail: matched ? "Record is assigned to the user." : "Record is not assigned to the user.",
      };
    }
  }
}

/**
 * The one place an access decision is made. Order of checks:
 *
 *  1. inactive user -> deny (nothing else is read for inactive users)
 *  2. active role assignments that grant the permission (expired, revoked, not-yet-effective and
 *     inactive-role assignments are ignored)
 *  3. resource resolution (a missing or cross-tenant record -> RESOURCE_NOT_FOUND)
 *  4. per grant: conditions, then scopes. A grant's permission only combines with ITS OWN scopes
 *     (PERMISSIONS.md section 1): scopes of another assignment never widen it.
 *
 * Everything is read from the database on every call (spec 25.5); there is no cache.
 */
export async function evaluateAccess(
  tx: TenantTx,
  subject: AccessSubject,
  permissionKey: string,
  resource: ResourceRef | undefined,
  now: Date,
): Promise<AccessEvaluation> {
  const state = await loadSubjectState(tx, subject);
  if (!state.isActive) return { decision: deny("USER_NOT_ACTIVE"), subject: state, grants: [], evaluations: [] };

  const grants = await loadGrants(tx, subject, permissionKey, now);
  const active = grants.filter((grant) => grant.status === "ACTIVE");
  if (active.length === 0) return { decision: deny("NO_PERMISSION"), subject: state, grants, evaluations: [] };

  let resolved: ResolvedResource | null = null;
  if (resource) {
    resolved = await resolveResource(tx, subject.tenantId, resource, now);
    if (!resolved) return { decision: deny("RESOURCE_NOT_FOUND"), subject: state, grants, evaluations: [] };
  }

  const evaluations: GrantEvaluation[] = [];
  let decision: AccessDecision | null = null;
  const fieldSets = new Set<string>();
  let sawConditionMet = false;
  let sawScope = false;

  for (const grant of active) {
    const conditions = grant.conditions;
    const conditionMet =
      conditions !== null &&
      // A record-set qualifier can only be checked against a concrete record.
      (conditions.set === undefined || resolved === null || resolved.sets.includes(conditions.set));
    if (!conditionMet) {
      evaluations.push({ grant, conditionMet, scopes: [] });
      continue;
    }
    sawConditionMet = true;
    if (grant.scopes.length > 0) sawScope = true;

    const scopeResults: ScopeEvaluation[] = [];
    for (const scope of grant.scopes) {
      // Capability check (no resource): any scope means the subject can act on SOME records.
      const result = resolved
        ? await matchScope(tx, subject.tenantId, scope, resolved, state.employeeId)
        : { scope, matched: true, detail: "Capability check: the grant has a data scope." };
      scopeResults.push(result);
      if (result.matched && !decision) {
        decision = { allowed: true, reason: "GRANTED", via: buildVia(grant, scope), fieldSets: [] };
      }
      // Union over every matching grant: a second role may reveal more fields than the first.
      if (result.matched && conditions) for (const tag of grantFieldSets(conditions)) fieldSets.add(tag);
    }
    evaluations.push({ grant, conditionMet, scopes: scopeResults });
  }

  if (decision) return { decision: { ...decision, fieldSets: [...fieldSets] }, subject: state, grants, evaluations };
  const reason: AccessReason = !sawConditionMet ? "CONDITION_NOT_MET" : !sawScope ? "NO_SCOPE" : "OUT_OF_SCOPE";
  return { decision: deny(reason), subject: state, grants, evaluations };
}
