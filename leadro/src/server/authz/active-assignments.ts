import type { Prisma } from "@prisma/client";
import type { TenantTx } from "@/server/db";

/**
 * The ONE definition of an "active" role assignment in a Prisma where-clause: not revoked, already
 * started and not yet expired (§25.5). `load-grants.ts` classifies rows with the same rules in
 * memory; keep the two in step.
 */
export const activeAssignmentWhere = (now: Date): Prisma.RoleAssignmentWhereInput => ({
  revokedAt: null,
  effectiveFrom: { lte: now },
  OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
});

/**
 * Does this user currently hold an ACTIVE assignment of an active role flagged `requiresMfa`?
 * Authentication calls it at login (§22.1 "MFA for sensitive roles"); keeping it here means there
 * is a single answer to "which assignments count right now".
 */
export async function holdsMfaRequiringRole(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const match = await tx.roleAssignment.findFirst({
    where: { tenantId, userId, ...activeAssignmentWhere(now), role: { active: true, requiresMfa: true } },
    select: { id: true },
  });
  return match !== null;
}
