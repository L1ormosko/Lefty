import { ForbiddenError, NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import {
  bootstrapRoleAssignment,
  validateScopes,
  type AssignRoleInput,
  type ScopeInput,
} from "./assign-role";
import { canInTx } from "./can";
import { fieldSetsCover, grantFieldSets, parseConditions } from "./conditions";
import { expandActiveOrgUnits } from "./org-tree";
import { resolveScope, type ScopePart } from "./scope-filter";
import type { AccessSubject, ResourceRef } from "./types";

/** `tenantId` and the granter come from the actor, never from the caller. */
export type ActorAssignRoleInput = Omit<AssignRoleInput, "tenantId" | "grantedById">;

/** A scope being handed out, with the org units it expands to (for ORG_UNIT). */
interface RequestedScope {
  scope: ScopeInput;
  neededUnits: string[];
}

/**
 * Can this ONE held scope (of one active grant) hand out `requested`? TENANT parts cover
 * everything; an org-unit part needs the unit and (with descendants) its whole active subtree;
 * legal-entity scopes need that entity; OWN/ASSIGNED only expose the target's own data, so any
 * part is enough.
 */
function partCovers(part: ScopePart, requested: RequestedScope): boolean {
  if (part.type === "TENANT") return true;
  switch (requested.scope.type) {
    case "TENANT":
      return false;
    case "LEGAL_ENTITY":
      return part.type === "LEGAL_ENTITY" && part.legalEntityIds.includes(requested.scope.legalEntityId ?? "");
    case "ORG_UNIT":
      // An archived (empty) unit is not coverable: fail closed.
      return (
        part.type === "ORG_UNIT" &&
        requested.neededUnits.length > 0 &&
        requested.neededUnits.every((id) => part.orgUnitIds.includes(id))
      );
    case "OWN":
    case "ASSIGNED":
      return true;
  }
}

/**
 * For every requested scope there must be a single held part that covers the scope AND whose own
 * grant reveals the required field sets. Checking scopes and field sets separately would let a
 * financial grant on City A combine with a plain grant on the tenant to hand out financial fields
 * tenant-wide.
 */
function heldCoversRequest(parts: ScopePart[], requested: RequestedScope[], requiredFieldSets: string[]): boolean {
  return requested.every((request) =>
    parts.some((part) => partCovers(part, request) && fieldSetsCover(part.fieldSets, requiredFieldSets)),
  );
}

/**
 * Grants a role on behalf of `actor`, with privilege-escalation protection. The actor must:
 *
 *  1. not be the target (separation of duties: nobody grants themselves access);
 *  2. have the TARGET user inside their `permissions.assign` scope (the target's employee
 *     placement; users without an employee count as tenant-level and need a tenant-wide grant);
 *  3. hold `permissions.assign` over scopes covering every scope being granted. A grant qualified
 *     `non_sensitive_roles` (COO) only counts for roles that are not `requiresMfa` and contain no
 *     sensitive permission;
 *  4. hold EVERY permission of the role through a single grant that covers each granted scope and
 *     the role grant's field sets (sensitive categories such as `financial` must be held explicitly).
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

  const [role, target] = await Promise.all([
    tx.role.findFirst({
      where: { id: input.roleId, tenantId },
      select: {
        requiresMfa: true,
        permissions: { select: { conditions: true, permission: { select: { key: true, sensitive: true } } } },
      },
    }),
    tx.user.findFirst({ where: { id: input.userId, tenantId }, select: { employee: { select: { id: true } } } }),
  ]);
  if (!role || !target) throw new NotFoundError({ message: "The user or role was not found." });

  const now = new Date();
  const isSensitiveRole = role.requiresMfa || role.permissions.some((entry) => entry.permission.sensitive);
  const assignSets = isSensitiveRole ? [] : ["non_sensitive_roles"];

  // The target must be someone the actor may administer, not just any user of the tenant.
  const targetRef: ResourceRef = { ...(target.employee ? { employeeId: target.employee.id } : {}), sets: assignSets };
  if (!(await canInTx(tx, actor, "permissions.assign", targetRef, now)).allowed) throw new ForbiddenError();

  const requested: RequestedScope[] = [];
  for (const scope of input.scopes) {
    const neededUnits = scope.orgUnitId
      ? await expandActiveOrgUnits(tx, tenantId, [scope.orgUnitId], scope.includeDescendants ?? true)
      : [];
    requested.push({ scope, neededUnits });
  }

  const mayAssign = await resolveScope(tx, actor, "permissions.assign", now, { satisfiedSets: assignSets });
  if (!heldCoversRequest(mayAssign.parts, requested, [])) throw new ForbiddenError();

  for (const entry of role.permissions) {
    const conditions = parseConditions(entry.conditions);
    if (conditions === null) continue; // malformed grants are unusable, so they hand out nothing
    const held = await resolveScope(tx, actor, entry.permission.key, now, {
      satisfiedSets: conditions.set ? [conditions.set] : [],
    });
    if (!heldCoversRequest(held.parts, requested, grantFieldSets(conditions))) {
      throw new ForbiddenError({ message: "You cannot grant a role containing permissions you do not hold." });
    }
  }

  return bootstrapRoleAssignment(tx, { ...input, tenantId, grantedById: actor.userId });
}
