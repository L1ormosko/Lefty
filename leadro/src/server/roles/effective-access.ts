import {
  activeAssignmentWhere,
  enforceInTx,
  enforceOnUser,
  explainAccess,
  type AccessExplanation,
} from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import type { EffectiveAccessQuery } from "./schemas";

export interface EffectiveAccess {
  userId: string;
  /** Not ACTIVE, or the employee is terminated: nothing below applies in that case. */
  accountActive: boolean;
  /** Role assignments in effect right now, each with its scopes and the role's permissions. */
  assignments: Array<{
    roleAssignmentId: string;
    roleId: string;
    roleName: string;
    requiresMfa: boolean;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    scopes: Array<{ type: string; legalEntityId: string | null; orgUnitId: string | null; includeDescendants: boolean }>;
    permissions: Array<{ permission: string; conditions: unknown }>;
  }>;
  /** Distinct permission keys across the active assignments (scopes differ per assignment). */
  permissions: string[];
  /** Present when `permission` was given: why that permission is (not) granted, possibly for one record. */
  explanation?: AccessExplanation;
}

/**
 * "What can this user do right now, and why?" (§4.6). Needs `permissions.view` over the target
 * user (their employee placement, or a tenant-wide grant for users without an employee), else 404
 * so a user outside the caller's scope is not confirmed to exist. Reads the live database like every
 * access decision. With `permission` (and optionally a record), the authz diagnostic `explainAccess`
 * adds the reasoning, including expired and revoked grants.
 */
export async function getEffectiveAccess(actor: Actor, query: EffectiveAccessQuery): Promise<EffectiveAccess> {
  const now = new Date();
  const view = await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "permissions.view");
    const user = await tx.user.findFirst({
      where: { id: query.userId, tenantId: actor.tenantId },
      select: {
        status: true,
        employee: { select: { id: true, status: true } },
        roleAssignments: {
          where: { ...activeAssignmentWhere(now), role: { active: true } },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            roleId: true,
            effectiveFrom: true,
            effectiveTo: true,
            role: { select: { name: true, requiresMfa: true, permissions: { select: { conditions: true, permission: { select: { key: true } } } } } },
            scopes: { select: { type: true, legalEntityId: true, orgUnitId: true, includeDescendants: true } },
          },
        },
      },
    });
    if (!user) throw new NotFoundError();
    await enforceOnUser(tx, actor, "permissions.view", { employeeId: user.employee?.id ?? null });

    const assignments = user.roleAssignments.map((assignment) => ({
      roleAssignmentId: assignment.id,
      roleId: assignment.roleId,
      roleName: assignment.role.name,
      requiresMfa: assignment.role.requiresMfa,
      effectiveFrom: assignment.effectiveFrom,
      effectiveTo: assignment.effectiveTo,
      scopes: assignment.scopes,
      permissions: assignment.role.permissions
        .map((entry) => ({ permission: entry.permission.key, conditions: entry.conditions ?? null }))
        .sort((a, b) => a.permission.localeCompare(b.permission)),
    }));
    return {
      userId: query.userId,
      accountActive: user.status === "ACTIVE" && user.employee?.status !== "TERMINATED",
      assignments,
      permissions: [...new Set(assignments.flatMap((assignment) => assignment.permissions.map((entry) => entry.permission)))].sort(),
    } satisfies EffectiveAccess;
  });

  if (!query.permission) return view;
  const resource = query.employeeId || query.orgUnitId ? { employeeId: query.employeeId, orgUnitId: query.orgUnitId } : undefined;
  // explainAccess re-checks the caller's authority (and the record's scope) itself.
  const explanation = await explainAccess(
    actor,
    query.userId,
    query.permission,
    resource && {
      ...(resource.employeeId ? { employeeId: resource.employeeId } : {}),
      ...(resource.orgUnitId ? { orgUnitId: resource.orgUnitId } : {}),
    },
  );
  return { ...view, explanation };
}
