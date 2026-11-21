import type { Actor } from "@/server/core";
import { ConflictError, NotFoundError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import { RATE_LIMITS } from "./config";
import type { ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import { assertPasswordMeetsPolicy, hashPassword, verifyPassword } from "./passwords";
import { enforceRateLimit } from "./rate-limiter";

/**
 * Changes the password of the signed-in user (§22.1). Requires the CURRENT password, so a hijacked
 * browser session alone cannot lock the owner out, and signs out every OTHER session of the user
 * (the one making the request stays), so whoever knew the old password loses access.
 *
 * Like login, bcrypt runs outside any transaction: read -> verify + hash -> short conditional
 * write. The write only applies while the stored hash is still the one that was verified, so a
 * concurrent change cannot be silently overwritten. Attempts are rate-limited per account because
 * this endpoint is a password oracle for anyone holding a session.
 *
 * @throws ValidationError (`currentPassword` wrong, or `password` policy violated / unchanged),
 *   RateLimitedError, ConflictError on a concurrent change, NotFoundError for a missing user.
 * @returns how many other sessions were revoked.
 */
export async function changeOwnPassword(
  actor: Actor,
  input: { currentPassword: string; newPassword: string },
  client: ClientInfo,
): Promise<{ revokedSessions: number }> {
  enforceRateLimit(`password-change:${actor.tenantId}:${actor.userId}`, RATE_LIMITS.passwordChangePerAccount);

  const user = await withTenant(actor.tenantId, (tx) =>
    tx.user.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId, status: "ACTIVE" },
      select: { email: true, passwordHash: true },
    }),
  );
  if (!user || !user.passwordHash) throw new NotFoundError();

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new ValidationError({ message: "The current password is incorrect.", field: "currentPassword" });
  }
  assertPasswordMeetsPolicy(input.newPassword, user.email);
  if (input.newPassword === input.currentPassword) {
    throw new ValidationError({ message: "The new password must differ from the current one.", field: "newPassword" });
  }
  const newHash = await hashPassword(input.newPassword);
  const verifiedHash = user.passwordHash;

  return withTenant(actor.tenantId, async (tx) => {
    const now = new Date();
    const updated = await tx.user.updateMany({
      where: { id: actor.userId, tenantId: actor.tenantId, status: "ACTIVE", passwordHash: verifiedHash },
      data: { passwordHash: newHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    if (updated.count === 0) throw new ConflictError({ message: "The password was changed concurrently. Please try again." });

    const revoked = await tx.session.updateMany({
      where: { tenantId: actor.tenantId, userId: actor.userId, revokedAt: null, id: { not: actor.sessionId } },
      data: { revokedAt: now },
    });
    await recordAuthEvent(tx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      type: "PASSWORD_CHANGED",
      client,
      metadata: { revokedSessions: revoked.count },
    });
    return { revokedSessions: revoked.count };
  });
}
