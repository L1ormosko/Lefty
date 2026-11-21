import { ValidationError } from "@/server/core";
import { prisma, withTenant } from "@/server/db";
import { PASSWORD_RESET_TTL_MS, RATE_LIMITS } from "./config";
import { enforceIpRateLimit, type ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import { normaliseEmail } from "./normalise-email";
import { getAuthNotifier } from "./notifier";
import { assertPasswordMeetsPolicy, hashPassword } from "./passwords";
import { hitRateLimit } from "./rate-limiter";
import { revokeAllSessionsForUser } from "./session-service";
import { hashToken, issueToken, tenantIdFromToken } from "./tokens";

/**
 * Starts a password reset. The caller always gets the same (empty) success, whether or not the
 * company code and email match an active account, so this endpoint cannot be used to discover
 * accounts (§22). Only the per-IP limit can produce an error, and it does so regardless of the input.
 * The per-account limit is applied silently for the same reason.
 *
 * A fresh token invalidates earlier unused ones. It is valid for 1 hour, single-use, stored only
 * as a SHA-256 hash, and handed to the configured `AuthNotifier`; it is never returned.
 */
export async function requestPasswordReset(
  input: { tenantSlug: string; email: string },
  client: ClientInfo,
): Promise<void> {
  enforceIpRateLimit(client, "reset:ip", RATE_LIMITS.passwordResetPerIp);
  const email = normaliseEmail(input.email);
  const tenantSlug = input.tenantSlug.trim().toLowerCase();
  if (!hitRateLimit(`reset:account:${tenantSlug}:${email}`, RATE_LIMITS.passwordResetPerAccount).allowed) return;

  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, status: true } });
  if (!tenant || tenant.status !== "ACTIVE") return;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
  const issued = await withTenant(tenant.id, async (tx) => {
    const user = await tx.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } } });
    if (!user || user.status !== "ACTIVE") return null;

    await tx.passwordResetToken.updateMany({
      where: { tenantId: tenant.id, userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    const { token, tokenHash } = issueToken(tenant.id);
    await tx.passwordResetToken.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash, expiresAt } });
    await recordAuthEvent(tx, { tenantId: tenant.id, userId: user.id, type: "PASSWORD_RESET_REQUESTED", client });
    return { userId: user.id, token };
  });

  if (issued) {
    await getAuthNotifier().sendPasswordReset({
      tenantId: tenant.id,
      userId: issued.userId,
      email,
      token: issued.token,
      expiresAt,
    });
  }
}

const INVALID_RESET_MESSAGE = "This password reset link is invalid or has expired.";

/**
 * Completes a reset: sets the new password, clears any lockout, and revokes ALL of the user's
 * sessions (whoever was logged in with the old password is signed out). The token is consumed
 * with a conditional UPDATE, so it works exactly once even under concurrent requests.
 *
 * Unknown, expired and already-used tokens all give the same error.
 */
export async function completePasswordReset(
  input: { token: string; newPassword: string },
  client: ClientInfo,
): Promise<void> {
  enforceIpRateLimit(client, "reset-confirm:ip", RATE_LIMITS.passwordResetConfirmPerIp);
  const tenantId = tenantIdFromToken(input.token);
  if (!tenantId) throw new ValidationError({ message: INVALID_RESET_MESSAGE });
  const tokenHash = hashToken(input.token);
  const invalid = () => new ValidationError({ message: INVALID_RESET_MESSAGE });

  // Step 1: short read, so a dead token is rejected before spending bcrypt time on it.
  const now = new Date();
  const record = await withTenant(tenantId, (tx) =>
    tx.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { email: true, status: true } } },
    }),
  );
  if (!record || record.tenantId !== tenantId || record.usedAt || record.expiresAt <= now || record.user.status !== "ACTIVE") {
    throw invalid();
  }

  // Step 2: hash outside any transaction (bcrypt cost 12 is deliberately slow).
  assertPasswordMeetsPolicy(input.newPassword, record.user.email);
  const passwordHash = await hashPassword(input.newPassword);

  // Step 3: short write transaction. The conditional UPDATE is what makes the token single-use.
  await withTenant(tenantId, async (tx) => {
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count === 0) throw invalid();
    // A user deactivated since step 1 cannot regain access (throwing rolls the token use back).
    const updated = await tx.user.updateMany({
      where: { id: record.userId, tenantId, status: "ACTIVE" },
      data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
    if (updated.count === 0) throw invalid();

    const revokedSessions = await revokeAllSessionsForUser(tx, tenantId, record.userId);
    await recordAuthEvent(tx, {
      tenantId,
      userId: record.userId,
      type: "PASSWORD_RESET_COMPLETED",
      client,
      metadata: { revokedSessions },
    });
  });
}
