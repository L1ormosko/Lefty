import type { TenantTx } from "@/server/db";

/**
 * Does this user have to pass an MFA challenge to log in? Yes when ANY currently active role
 * assignment points at an active role with `requiresMfa` (§22.1 "MFA for sensitive roles").
 *
 * "Active" = not revoked, `effectiveFrom <= now` and (`effectiveTo` is null or `> now`).
 *
 * This queries Role/RoleAssignment directly so auth does not depend on the authorization engine.
 * It is the single place to repoint at `src/server/authz` later.
 */
export async function userRequiresMfa(tx: TenantTx, tenantId: string, userId: string, now = new Date()): Promise<boolean> {
  const matching = await tx.roleAssignment.findFirst({
    where: {
      tenantId,
      userId,
      revokedAt: null,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      role: { active: true, requiresMfa: true },
    },
    select: { id: true },
  });
  return matching !== null;
}
