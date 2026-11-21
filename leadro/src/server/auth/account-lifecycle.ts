import { NotFoundError } from "@/server/core";
import { recordAudit } from "@/server/audit";
import { withTenant } from "@/server/db";
import type { ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import { revokeAllSessionsForUser } from "./session-service";

/**
 * Deactivates a user account and revokes every one of their sessions in the same transaction, so
 * there is no moment where a deactivated user still holds a working session. (Sessions are also
 * re-checked against `User.status` on every request as a second line of defence.)
 *
 * The caller (user administration) must have checked the actor's permission first.
 *
 * @throws NotFoundError if the user does not exist in the tenant.
 */
export async function deactivateUserAccount(
  tenantId: string,
  userId: string,
  actorUserId: string | null,
  client: ClientInfo,
  reason?: string,
): Promise<{ revokedSessions: number }> {
  return withTenant(tenantId, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.tenantId !== tenantId) throw new NotFoundError();

    await tx.user.update({ where: { id: userId }, data: { status: "DEACTIVATED" } });
    const revokedSessions = await revokeAllSessionsForUser(tx, tenantId, userId);
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action: "user.deactivate",
      targetType: "User",
      targetId: userId,
      previousValue: { status: user.status },
      newValue: { status: "DEACTIVATED", revokedSessions },
      reason,
      sourceApp: client.sourceApp,
      correlationId: client.correlationId,
      ipAddress: client.ipAddress,
    });
    if (revokedSessions > 0) {
      await recordAuthEvent(tx, {
        tenantId,
        userId,
        type: "SESSION_REVOKED",
        client,
        metadata: { reason: "account_deactivated", revokedSessions },
      });
    }
    return { revokedSessions };
  });
}
