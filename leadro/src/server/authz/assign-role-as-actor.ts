import { ForbiddenError, NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { bootstrapRoleAssignment, validateScopes, type AssignRoleInput, type ScopeInput } from "./assign-role";
import { grantFieldSets, parseConditions } from "./conditions";
import { assertMayAdminister, heldCoversRequest } from "./role-grant-check";
import { resolveScope } from "./scope-filter";
import type { AccessSubject } from "./types";

/** `tenantId` and the granter come from the actor, never from the caller. */
export type ActorAssignRoleInput = Omit<AssignRoleInput, "tenantId" | "grantedById">;

/** Who receives the role: an existing user, or a person who does not have an account yet. */
export interface GrantTarget {
  /** The target's employee record (null/undefined: a tenant-level user without one). */
  employeeId?: string | null;
}

/**
 * The anti-escalation rules of granting, WITHOUT writing anything (a dry run). The actor must:
 *
 *  1. have the TARGET inside their `permissions.assign` scope (the target's employee placement;
 *     a target without an employee counts as tenant-level and needs a tenant-wide grant);
 *  2. hold `permissions.assign` over scopes covering every scope being granted. A grant qualified
 *     `non_sensitive_roles` (COO) only counts for roles that are not `requiresMfa` and contain no
 *     sensitive permission;
 *  3. hold EVERY permission of the role through a single grant that covers each granted scope and
 *     the role grant's field sets (sensitive categories such as `financial` must be held explicitly).
 *
 * `assignRole` runs it before writing; invitations run it when the invitation is created and again
 * when it is accepted (the inviter's authority must still exist then).
 *
 * @throws ValidationError for malformed scopes, NotFoundError for an unknown role,
 *   ForbiddenError for any violation.
 */
export async function assertMayGrantRole(
  tx: TenantTx,
  actor: AccessSubject,
  input: { roleId: string; scopes: ScopeInput[]; target: GrantTarget },
  now: Date = new Date(),
): Promise<void> {
  validateScopes(input.scopes);
  const role = await tx.role.findFirst({
    where: { id: input.roleId, tenantId: actor.tenantId },
    select: {
      requiresMfa: true,
      permissions: { select: { conditions: true, permission: { select: { key: true, sensitive: true } } } },
    },
  });
  if (!role) throw new NotFoundError({ message: "The user or role was not found." });

  const isSensitiveRole = role.requiresMfa || role.permissions.some((entry) => entry.permission.sensitive);
  const requested = await assertMayAdminister(
    tx,
    actor,
    { employeeId: input.target.employeeId ?? null },
    isSensitiveRole,
    input.scopes,
    now,
  );

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
}

/**
 * Grants a role on behalf of `actor`, with privilege-escalation protection: nobody grants
 * themselves access (separation of duties), and `assertMayGrantRole` must pass. Then it behaves
 * like `bootstrapRoleAssignment` (validation, duplicate guard, audit with the actor as granter).
 * Run inside `withTenant(actor.tenantId, ...)`.
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

  const target = await tx.user.findFirst({
    where: { id: input.userId, tenantId },
    select: { employee: { select: { id: true } } },
  });
  if (!target) throw new NotFoundError({ message: "The user or role was not found." });

  await assertMayGrantRole(tx, actor, {
    roleId: input.roleId,
    scopes: input.scopes,
    target: { employeeId: target.employee?.id ?? null },
  });

  return bootstrapRoleAssignment(tx, { ...input, tenantId, grantedById: actor.userId });
}
