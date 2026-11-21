import { ForbiddenError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { activeAssignmentWhere } from "./active-assignments";
import { assertMayAdminister } from "./role-grant-check";
import type { AccessSubject } from "./types";

/**
 * Taking someone out of the company (terminating their employee record, which makes authz ignore
 * them) is also a way to lock a privileged person out. So an actor may only do it to a user who
 * holds a SENSITIVE role (requiresMfa or a sensitive permission) if they could also revoke that
 * very assignment (`permissions.assign` over the person and the assignment's scopes). HR can
 * therefore never lock out the Owner. Users with only non-sensitive roles, or none, are not gated here.
 *
 * Run inside `withTenant(actor.tenantId, ...)`.
 * @throws ForbiddenError
 */
export async function assertMayDisableUser(tx: TenantTx, actor: AccessSubject, userId: string, now: Date = new Date()): Promise<void> {
  const assignments = await tx.roleAssignment.findMany({
    where: { tenantId: actor.tenantId, userId, ...activeAssignmentWhere(now), role: { active: true } },
    select: {
      role: { select: { requiresMfa: true, permissions: { select: { permission: { select: { sensitive: true } } } } } },
      scopes: { select: { type: true, legalEntityId: true, orgUnitId: true, includeDescendants: true } },
      user: { select: { employee: { select: { id: true } } } },
    },
  });
  for (const assignment of assignments) {
    const sensitive = assignment.role.requiresMfa || assignment.role.permissions.some((entry) => entry.permission.sensitive);
    if (!sensitive) continue;
    try {
      await assertMayAdminister(
        tx,
        actor,
        { employeeId: assignment.user.employee?.id ?? null },
        true,
        assignment.scopes.map((scope) => ({
          type: scope.type,
          legalEntityId: scope.legalEntityId ?? undefined,
          orgUnitId: scope.orgUnitId ?? undefined,
          includeDescendants: scope.includeDescendants,
        })),
        now,
      );
    } catch {
      throw new ForbiddenError({ message: "This person holds a privileged role you are not allowed to administer." });
    }
  }
}
