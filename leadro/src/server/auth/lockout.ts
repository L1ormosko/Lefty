import type { User } from "@prisma/client";
import type { TenantTx } from "@/server/db";
import { LOCKOUT_DURATION_MS, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_MS } from "./config";
import type { ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";

type LockoutFields = Pick<User, "id" | "tenantId" | "lockedUntil" | "lastLoginAt" | "passwordChangedAt">;

/** True while the account is inside its lock period. */
export function isLockedOut(user: Pick<User, "lockedUntil">, now: Date): boolean {
  return user.lockedUntil !== null && user.lockedUntil > now;
}

/**
 * Called right after a failed password or MFA attempt was recorded. If the account now has
 * `LOCKOUT_MAX_FAILURES` failures within `LOCKOUT_WINDOW_MS`, locks it for `LOCKOUT_DURATION_MS`
 * and records ACCOUNT_LOCKED (§22.1 account lockout protections).
 *
 * Failures are counted from the AuthenticationEvent history rather than a counter column, because
 * a "5 failures in 15 minutes" window needs timestamps. The window never reaches back past the
 * last successful login, the end of a previous lock, or a password change, so those events reset
 * the count without any extra bookkeeping. Attempts made WHILE locked fall before `lockedUntil`
 * and so cannot re-lock the account the instant the lock ends.
 *
 * @returns true if this call locked the account.
 */
export async function lockIfTooManyFailures(
  tx: TenantTx,
  user: LockoutFields,
  client: ClientInfo,
  now: Date,
): Promise<boolean> {
  const windowStart = new Date(
    Math.max(
      now.getTime() - LOCKOUT_WINDOW_MS,
      user.lockedUntil?.getTime() ?? 0,
      user.lastLoginAt?.getTime() ?? 0,
      user.passwordChangedAt?.getTime() ?? 0,
    ),
  );
  const failures = await tx.authenticationEvent.count({
    where: {
      tenantId: user.tenantId,
      userId: user.id,
      type: { in: ["LOGIN_FAILED", "MFA_CHALLENGE_FAILED"] },
      occurredAt: { gt: windowStart },
    },
  });
  await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: failures } });
  if (failures < LOCKOUT_MAX_FAILURES) return false;

  const lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
  await tx.user.update({ where: { id: user.id }, data: { lockedUntil } });
  await recordAuthEvent(tx, {
    tenantId: user.tenantId,
    userId: user.id,
    type: "ACCOUNT_LOCKED",
    client,
    metadata: { failures, lockedUntil: lockedUntil.toISOString() },
  });
  return true;
}
