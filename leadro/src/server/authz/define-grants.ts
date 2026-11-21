import { ForbiddenError, ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { fieldSetsCover, grantFieldSets, parseConditions } from "./conditions";
import { isPermissionKey } from "./permission-catalog";
import { resolveScope } from "./scope-filter";
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
