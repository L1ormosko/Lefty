import type { Actor } from "@/server/core";
import { UnauthenticatedError } from "@/server/core";
import { prisma, withTenant } from "@/server/db";
import { RATE_LIMITS } from "./config";
import { clientKey, type ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import { normaliseEmail } from "./normalise-email";
import { isLockedOut, lockIfTooManyFailures } from "./lockout";
import { userRequiresMfa } from "./mfa-policy";
import { burnPasswordCheck, verifyPassword } from "./passwords";
import { enforceRateLimit } from "./rate-limiter";
import { createSession } from "./session-service";

export interface LoginInput {
  /** The company code (§ identity ruling: users log in with tenant slug + email + password). */
  tenantSlug: string;
  email: string;
  password: string;
}

export interface LoginResult {
  /** Raw session token for the cookie. */
  token: string;
  expiresAt: Date;
  userId: string;
  /** True when the session cannot be used until an MFA code is verified (or enrolled first). */
  mfaRequired: boolean;
  /** With `mfaRequired`: the user has no authenticator yet and must enroll before verifying. */
  mfaEnrollmentRequired: boolean;
}

/** Same text for every failure so a caller cannot tell a wrong password from an unknown account. */
const INVALID_CREDENTIALS_MESSAGE = "The company code, email or password is incorrect.";
const invalidCredentials = (): UnauthenticatedError => new UnauthenticatedError({ message: INVALID_CREDENTIALS_MESSAGE });

type FailureReason = "unknown_user" | "no_password" | "inactive_account" | "locked" | "bad_password";

/**
 * Logs in with company code + email + password (§22.1).
 *
 * Failure is always the same generic `UnauthenticatedError`, whatever the cause (unknown company,
 * unknown email, wrong password, deactivated, locked): the real reason goes only to the login
 * history and audit log. A throw-away bcrypt check runs on every path that has no password hash to
 * test, so timing does not reveal which accounts exist either.
 *
 * Tenant resolution comes first (Tenant has no RLS); everything else runs inside `withTenant`.
 * If any of the user's active roles require MFA (or the user enrolled MFA), the returned session
 * is `mfaPending` and only works for the MFA endpoints until a code is verified.
 *
 * @throws UnauthenticatedError on any credential problem, RateLimitedError when throttled.
 */
export async function login(input: LoginInput, client: ClientInfo): Promise<LoginResult> {
  const email = normaliseEmail(input.email);
  const tenantSlug = input.tenantSlug.trim().toLowerCase();
  enforceRateLimit(`login:ip:${clientKey(client)}`, RATE_LIMITS.loginPerIp);
  enforceRateLimit(`login:account:${tenantSlug}:${email}`, RATE_LIMITS.loginPerAccount);

  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, status: true } });
  if (!tenant || tenant.status !== "ACTIVE") {
    await burnPasswordCheck(input.password);
    throw invalidCredentials();
  }

  const now = new Date();
  const outcome = await withTenant(tenant.id, async (tx) => {
    const user = await tx.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } } });
    const fail = async (reason: FailureReason) => {
      await recordAuthEvent(tx, {
        tenantId: tenant.id,
        userId: user?.id ?? null,
        type: "LOGIN_FAILED",
        client,
        emailAttempted: email,
        metadata: { reason },
      });
      // Only a real wrong password counts toward lockout; attempts while locked must not extend it.
      if (user && reason === "bad_password") await lockIfTooManyFailures(tx, user, client, now);
      return { ok: false as const };
    };

    if (!user) {
      await burnPasswordCheck(input.password);
      return fail("unknown_user");
    }
    if (!user.passwordHash) {
      await burnPasswordCheck(input.password);
      return fail("no_password");
    }
    if (user.status !== "ACTIVE") {
      await burnPasswordCheck(input.password);
      return fail("inactive_account");
    }
    if (isLockedOut(user, now)) {
      await burnPasswordCheck(input.password);
      return fail("locked");
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) return fail("bad_password");

    const mfaRequired = user.mfaEnabled || (await userRequiresMfa(tx, tenant.id, user.id, now));
    const session = await createSession(tx, { tenantId: tenant.id, userId: user.id, mfaPending: mfaRequired, client });
    if (!mfaRequired) {
      // A fully logged-in user starts with a clean failure count; for MFA users this happens
      // after the second factor, so a guessed password alone does not reset the lockout window.
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now, failedLoginCount: 0 } });
    }
    await recordAuthEvent(tx, {
      tenantId: tenant.id,
      userId: user.id,
      type: "LOGIN_SUCCEEDED",
      client,
      metadata: { mfaPending: mfaRequired, sessionId: session.sessionId },
    });
    return {
      ok: true as const,
      session,
      userId: user.id,
      mfaRequired,
      mfaEnrollmentRequired: mfaRequired && !user.mfaEnabled,
    };
  });

  if (!outcome.ok) throw invalidCredentials();
  return {
    token: outcome.session.token,
    expiresAt: outcome.session.expiresAt,
    userId: outcome.userId,
    mfaRequired: outcome.mfaRequired,
    mfaEnrollmentRequired: outcome.mfaEnrollmentRequired,
  };
}

/** Revokes the caller's current session and records the logout. */
export async function logout(actor: Actor, client: ClientInfo): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    await tx.session.updateMany({
      where: { id: actor.sessionId, tenantId: actor.tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAuthEvent(tx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      type: "LOGOUT",
      client,
      metadata: { sessionId: actor.sessionId },
    });
  });
}
