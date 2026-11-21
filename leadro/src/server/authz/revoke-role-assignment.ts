import { recordAudit } from "@/server/audit";
import { InvalidStateTransitionError, NotFoundError, type SourceApp } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { assertMayAdminister } from "./role-grant-check";
import type { AccessSubject } from "./types";

export interface RevokeRoleAssignmentInput {
  roleAssignmentId: string;
  /** Why access is being withdrawn; stored on the audit event. */
  reason?: string;
  sourceApp?: SourceApp;
  correlationId?: string;
}

/**
 * Ends a role assignment now (history is kept: the row stays, `revokedAt`/`revokedById` are set).
 *
 * The actor needs the same authority that granting would: `permissions.assign` on the target user
 * and over every scope of the assignment, with the `non_sensitive_roles` qualifier honoured. So a
 * City manager cannot strip a tenant-wide assignment from someone in their city, and a COO cannot
 * revoke an Owner role. Revoking one's own assignment is allowed: it only ever reduces access.
 *
 * Run inside `withTenant(actor.tenantId, ...)`. Serialised with granting by the same per-user lock.
 *
 * @throws NotFoundError for an unknown assignment, InvalidStateTransitionError when already
 *   revoked, ForbiddenError when the actor lacks the authority.
 */
export async function revokeRoleAssignment(
  tx: TenantTx,
  actor: AccessSubject,
  input: RevokeRoleAssignmentInput,
): Promise<void> {
  const tenantId = actor.tenantId;
  const assignment = await tx.roleAssignment.findFirst({
    where: { id: input.roleAssignmentId, tenantId },
    select: {
      id: true,
      userId: true,
      roleId: true,
      revokedAt: true,
      role: { select: { requiresMfa: true, permissions: { select: { permission: { select: { sensitive: true } } } } } },
      scopes: { select: { type: true, legalEntityId: true, orgUnitId: true, includeDescendants: true } },
      user: { select: { employee: { select: { id: true } } } },
    },
  });
  if (!assignment) throw new NotFoundError({ message: "The role assignment was not found." });

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`role-assignment:${tenantId}:${assignment.userId}`}))`;
  if (assignment.revokedAt) throw new InvalidStateTransitionError({ message: "This role assignment is already revoked." });

  const isSensitiveRole = assignment.role.requiresMfa || assignment.role.permissions.some((entry) => entry.permission.sensitive);
  await assertMayAdminister(
    tx,
    actor,
    { employeeId: assignment.user.employee?.id ?? null },
    isSensitiveRole,
    assignment.scopes.map((scope) => ({
      type: scope.type,
      legalEntityId: scope.legalEntityId ?? undefined,
      orgUnitId: scope.orgUnitId ?? undefined,
      includeDescendants: scope.includeDescendants,
    })),
    new Date(),
  );

  // Conditional update: two concurrent revokes cannot both "win" and double-audit.
  const revokedAt = new Date();
  const updated = await tx.roleAssignment.updateMany({
    where: { id: assignment.id, tenantId, revokedAt: null },
    data: { revokedAt, revokedById: actor.userId },
  });
  if (updated.count === 0) throw new InvalidStateTransitionError({ message: "This role assignment is already revoked." });

  await recordAudit(tx, {
    tenantId,
    actorUserId: actor.userId,
    action: "role_assignment.revoke",
    targetType: "RoleAssignment",
    targetId: assignment.id,
    previousValue: { userId: assignment.userId, roleId: assignment.roleId },
    newValue: { revokedAt: revokedAt.toISOString() },
    reason: input.reason,
    sourceApp: input.sourceApp ?? "API",
    correlationId: input.correlationId,
  });
}
