import { ForbiddenError, NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import {
  bootstrapRoleAssignment,
  validateScopes,
  type AssignRoleInput,
  type ScopeInput,
} from "./assign-role";
import { fieldSetsCover, grantFieldSets, parseConditions } from "./conditions";
import { expandActiveOrgUnits } from "./org-tree";
import { resolveScope, type ResolvedScope } from "./scope-filter";
import type { AccessSubject } from "./types";

/** `tenantId` and the granter come from the actor, never from the caller. */
export type ActorAssignRoleInput = Omit<AssignRoleInput, "tenantId" | "grantedById">;

const hasAnyScope = (scope: ResolvedScope): boolean =>
  scope.tenantWide ||
  scope.orgUnitIds.length > 0 ||
  scope.legalEntityIds.length > 0 ||
  scope.ownEmployeeId !== null ||
  scope.assignedEmployeeId !== null;

/**
 * Does the granter's scope for one permission cover every scope being handed out? TENANT needs a
 * tenant-wide grant; an org unit needs the unit and (with descendants) its whole active subtree;
 * OWN/ASSIGNED only ever expose the target's own data, so any scope of the granter is enough.
 */
async function scopeCovers(
  tx: TenantTx,
  tenantId: string,
  held: ResolvedScope,
  requested: ScopeInput[],
): Promise<boolean> {
  if (held.tenantWide) return true;
  for (const scope of requested) {
    switch (scope.type) {
      case "TENANT":
        return false;
      case "LEGAL_ENTITY":
        if (!scope.legalEntityId || !held.legalEntityIds.includes(scope.legalEntityId)) return false;
        break;
      case "ORG_UNIT": {
        const needed = scope.orgUnitId
          ? await expandActiveOrgUnits(tx, tenantId, [scope.orgUnitId], scope.includeDescendants ?? true)
          : [];
        // An archived (empty) unit is not coverable: fail closed.
        if (needed.length === 0 || !needed.every((id) => held.orgUnitIds.includes(id))) return false;
        break;
      }
      case "OWN":
      case "ASSIGNED":
        if (!hasAnyScope(held)) return false;
        break;
    }
  }
  return true;
}

/**
 * Grants a role on behalf of `actor`, with privilege-escalation protection. The actor must:
 *
 *  1. not be the target (separation of duties: nobody grants themselves access);
 *  2. hold `permissions.assign` over scopes covering every scope being granted. A grant qualified
 *     `non_sensitive_roles` (COO) only counts for roles that are not `requiresMfa` and contain no
 *     sensitive permission;
 *  3. hold EVERY permission of the role, over scopes covering the granted scopes, and cover its
 *     field sets (sensitive categories such as `financial` must be held explicitly).
 *
 * Violations throw `ForbiddenError`. Then it behaves like `bootstrapRoleAssignment` (validation,
 * duplicate guard, audit with the actor as granter). Run inside `withTenant(actor.tenantId, ...)`.
 */
export async function assignRole(
  tx: TenantTx,
  actor: AccessSubject,
  input: ActorAssignRoleInput,
): Promise<{ roleAssignmentId: string }> {
  const tenantId = actor.tenantId;
  if (input.userId === actor.userId) {
    throw new ForbiddenError({ message: "You cannot assign roles to yourself." });
  }
  validateScopes(input.scopes);

  const role = await tx.role.findFirst({
    where: { id: input.roleId, tenantId },
    select: {
      requiresMfa: true,
      permissions: { select: { conditions: true, permission: { select: { key: true, sensitive: true } } } },
    },
  });
  if (!role) throw new NotFoundError({ message: "The user or role was not found." });

  const now = new Date();
  const isSensitiveRole = role.requiresMfa || role.permissions.some((entry) => entry.permission.sensitive);
  const mayAssign = await resolveScope(tx, actor, "permissions.assign", now, {
    satisfiedSets: isSensitiveRole ? [] : ["non_sensitive_roles"],
  });
  if (!(await scopeCovers(tx, tenantId, mayAssign, input.scopes))) throw new ForbiddenError();

  for (const entry of role.permissions) {
    const conditions = parseConditions(entry.conditions);
    if (conditions === null) continue; // malformed grants are unusable, so they hand out nothing
    const held = await resolveScope(tx, actor, entry.permission.key, now, {
      satisfiedSets: conditions.set ? [conditions.set] : [],
    });
    const covered =
      (await scopeCovers(tx, tenantId, held, input.scopes)) &&
      fieldSetsCover(held.fieldSets, grantFieldSets(conditions));
    if (!covered) {
      throw new ForbiddenError({ message: "You cannot grant a role containing permissions you do not hold." });
    }
  }

  return bootstrapRoleAssignment(tx, { ...input, tenantId, grantedById: actor.userId });
}
