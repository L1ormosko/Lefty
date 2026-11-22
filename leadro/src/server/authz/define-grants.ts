import { liveOrFutureAssignmentWhere } from "./time-windows";
import { ForbiddenError, ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { fieldSetsCover, grantFieldSets, parseConditions } from "./conditions";
import { isPermissionKey } from "./permission-catalog";
import { resolveScope } from "./scope-filter";
import { expandRequestedScopes, heldCoversRequest } from "./role-grant-check";
import type { AccessSubject } from "./types";

/** One permission of a role being created or edited, as it will be stored. */
export interface RoleGrantDefinition {
  permission: string;
  /** Qualifiers (`fields`, `includeFields`, `set`); validated strictly. */
  conditions?: unknown;
}

/**
 * Anti-escalation for ROLE DEFINITIONS (create, clone, edit permissions): nobody can put a
 * permission into a role that they do not hold themselves. Otherwise an administrator with
 * `permissions.create` could mint a role with `compensation.approve` and assign it to a friend.
 *
 * For each grant the actor must hold the permission through ONE active grant of their own that
 * reveals at least the same field sets (so a plain `employees.view` holder cannot define a role with
 * the sensitive `financial` field set), and for a `set`-qualified grant a held grant that covers
 * that set or no set at all. Scopes are not part of a role definition (they belong to assignments,
 * which `assignRole` checks separately), so any held scope is enough here.
 *
 * Run inside `withTenant(actor.tenantId, ...)`.
 * @throws ValidationError for an unknown permission or malformed conditions, ForbiddenError otherwise.
 */
export async function assertMayDefineGrants(
  tx: TenantTx,
  actor: AccessSubject,
  grants: RoleGrantDefinition[],
  now: Date = new Date(),
): Promise<void> {
  for (const grant of grants) {
    if (!isPermissionKey(grant.permission)) {
      throw new ValidationError({ message: `Unknown permission "${grant.permission}".`, field: "permissions" });
    }
    const conditions = parseConditions((grant.conditions ?? null) as never);
    if (conditions === null) {
      throw new ValidationError({ message: `Invalid conditions for "${grant.permission}".`, field: "permissions" });
    }
    const held = await resolveScope(tx, actor, grant.permission, now, {
      satisfiedSets: conditions.set ? [conditions.set] : [],
    });
    const required = grantFieldSets(conditions);
    if (!held.parts.some((part) => fieldSetsCover(part.fieldSets, required))) {
      throw new ForbiddenError({ message: "You cannot grant permissions you do not hold." });
    }
  }
}

/**
 * Editing a role that is ALREADY assigned changes access immediately for every holder, so the
 * editor must be able to hand each added/changed grant to each live holder's scopes, exactly as
 * `assignRole` would require: a single held part must cover the assignment's scope and the grant's
 * field sets. (An editor with employees.view over City A only must not add it to a role held
 * tenant-wide.) Revoked and expired assignments are ignored.
 *
 * @throws ForbiddenError
 */
export async function assertMayGrantToExistingHolders(
  tx: TenantTx,
  actor: AccessSubject,
  roleId: string,
  grants: RoleGrantDefinition[],
  now: Date = new Date(),
): Promise<void> {
  if (grants.length === 0) return;
  const assignments = await tx.roleAssignment.findMany({
    where: { tenantId: actor.tenantId, roleId, ...liveOrFutureAssignmentWhere(now) },
    select: { scopes: { select: { type: true, legalEntityId: true, orgUnitId: true, includeDescendants: true } } },
  });
  for (const grant of grants) {
    const conditions = parseConditions((grant.conditions ?? null) as never);
    if (conditions === null) continue; // already rejected by assertMayDefineGrants
    const held = await resolveScope(tx, actor, grant.permission, now, { satisfiedSets: conditions.set ? [conditions.set] : [] });
    for (const assignment of assignments) {
      const requested = await expandRequestedScopes(
        tx,
        actor.tenantId,
        assignment.scopes.map((scope) => ({
          type: scope.type,
          legalEntityId: scope.legalEntityId ?? undefined,
          orgUnitId: scope.orgUnitId ?? undefined,
          includeDescendants: scope.includeDescendants,
        })),
      );
      if (!heldCoversRequest(held.parts, requested, grantFieldSets(conditions))) {
        throw new ForbiddenError({ message: "This role is assigned over scopes you cannot grant these permissions in." });
      }
    }
  }
}
