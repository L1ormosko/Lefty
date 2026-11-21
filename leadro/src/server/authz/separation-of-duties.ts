import { ForbiddenError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import type { AccessSubject } from "./types";

/**
 * Separation of duties (§21.3, §25.5): nobody approves or rejects a change they submitted
 * themselves. Call it in every approve/reject service, with the submitter recorded on the subject.
 *
 * A subject without a recorded submitter (system-created) cannot be a self-approval.
 */
export function assertNotSelfApproval(actorId: string, subjectCreatedById: string | null | undefined): void {
  if (subjectCreatedById !== null && subjectCreatedById !== undefined && subjectCreatedById === actorId) {
    throw new ForbiddenError({ message: "You cannot approve or reject your own submission." });
  }
}

/**
 * Separation of duties for role administration (§21.3): nobody edits, archives or re-scopes a role
 * that is assigned to themselves, because that would let them rewrite their own access. A role
 * counts as "assigned" while any non-revoked assignment of it to the actor has not yet expired
 * (future-dated ones included, so the loophole "edit it before it starts" does not exist).
 *
 * Run inside `withTenant(actor.tenantId, ...)`.
 * @throws ForbiddenError
 */
export async function assertNotHoldingRole(tx: TenantTx, actor: AccessSubject, roleId: string): Promise<void> {
  const now = new Date();
  const held = await tx.roleAssignment.findFirst({
    where: {
      tenantId: actor.tenantId,
      userId: actor.userId,
      roleId,
      revokedAt: null,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { id: true },
  });
  if (held) throw new ForbiddenError({ message: "You cannot change a role that is assigned to you." });
}
