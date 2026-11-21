/**
 * TOTP multi-factor authentication (§22.1 "MFA for sensitive roles"): enrollment, confirmation
 * and the login challenge. All three work on a session that is still `mfaPending`, which is how
 * a user whose role newly requires MFA gets enrolled without being locked out.
 *
 * The TOTP seed is stored AES-256-GCM encrypted (secret-box.ts) and is shown to the user exactly
 * once, at enrollment. Wrong codes count toward the same lockout as wrong passwords, and a code
 * that was already accepted cannot be used a second time.
 */
import type { Actor } from "@/server/core";
import { ConflictError, InvalidStateTransitionError, NotFoundError, RateLimitedError, ValidationError } from "@/server/core";
import { recordAudit } from "@/server/audit";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import {
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  verifyTotp,
} from "@/lib/totp";
import { LOCKOUT_DURATION_MS, MFA_ISSUER, RATE_LIMITS, TOTP_REPLAY_WINDOW_MS } from "./config";
import type { ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import { isLockedOut, lockIfTooManyFailures } from "./lockout";
import { enforceRateLimit } from "./rate-limiter";
import { decryptSecret, encryptSecret } from "./secret-box";

export interface MfaEnrollment {
  /** Base32 seed for manual entry. Returned only here, never again. */
  secret: string;
  /** `otpauth://` URI for a QR code. Contains the seed: do not log it. */
  otpauthUri: string;
}

const INVALID_CODE_MESSAGE = "The verification code is not valid.";

async function loadUser(tx: TenantTx, actor: Actor) {
  const user = await tx.user.findUnique({ where: { id: actor.userId } });
  if (!user || user.tenantId !== actor.tenantId) throw new NotFoundError();
  return user;
}

/**
 * Generates a new TOTP seed for the caller and stores it encrypted, not yet active. MFA only
 * switches on once `confirmMfaEnrollment` proves the user's app can produce codes.
 * Refuses when MFA is already enabled so a stolen session cannot silently replace the authenticator.
 *
 * @throws ConflictError if MFA is already enabled; EncryptionKeyError if LEADRO_ENCRYPTION_KEY is missing/invalid.
 */
export async function startMfaEnrollment(actor: Actor, client: ClientInfo): Promise<MfaEnrollment> {
  const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { slug: true } });
  return withTenant(actor.tenantId, async (tx) => {
    const user = await loadUser(tx, actor);
    if (user.mfaEnabled) throw new ConflictError({ message: "Multi-factor authentication is already enabled." });

    const secret = generateTotpSecret();
    await tx.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encryptSecret(secret) } });
    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "auth.mfa_enroll_start",
      targetType: "User",
      targetId: user.id,
      sourceApp: client.sourceApp,
      correlationId: client.correlationId,
      ipAddress: client.ipAddress,
    });
    return {
      secret: base32Encode(secret),
      otpauthUri: buildOtpauthUri({ issuer: MFA_ISSUER, account: `${tenant?.slug ?? "tenant"}:${user.email}`, secret }),
    };
  });
}

/**
 * Checks a submitted code against the caller's stored seed and records the outcome.
 * @returns true when the code is valid and unused. Failures are recorded (and may lock the account).
 */
async function checkCode(
  tx: TenantTx,
  actor: Actor,
  code: string,
  client: ClientInfo,
  context: { enrolling: boolean },
): Promise<boolean> {
  const now = new Date();
  const user = await loadUser(tx, actor);
  if (isLockedOut(user, now)) {
    throw new RateLimitedError({ retryAfterSeconds: Math.ceil(LOCKOUT_DURATION_MS / 1000), message: "The account is temporarily locked." });
  }
  if (!user.mfaSecretEncrypted) {
    throw new InvalidStateTransitionError({ message: "Multi-factor authentication has not been set up." });
  }

  const timeStep = verifyTotp(decryptSecret(user.mfaSecretEncrypted), code, now.getTime());
  const alreadyUsed =
    timeStep !== null &&
    (await tx.authenticationEvent.findFirst({
      where: {
        tenantId: actor.tenantId,
        userId: user.id,
        type: "MFA_CHALLENGE_SUCCEEDED",
        occurredAt: { gt: new Date(now.getTime() - TOTP_REPLAY_WINDOW_MS) },
        metadata: { path: ["timeStep"], equals: timeStep },
      },
      select: { id: true },
    })) !== null;

  if (timeStep === null || alreadyUsed) {
    await recordAuthEvent(tx, {
      tenantId: actor.tenantId,
      userId: user.id,
      type: "MFA_CHALLENGE_FAILED",
      client,
      metadata: { reason: alreadyUsed ? "code_reused" : "bad_code", enrolling: context.enrolling },
    });
    await lockIfTooManyFailures(tx, user, client, now);
    return false;
  }

  await recordAuthEvent(tx, {
    tenantId: actor.tenantId,
    userId: user.id,
    type: "MFA_CHALLENGE_SUCCEEDED",
    client,
    metadata: { timeStep, enrolling: context.enrolling },
  });
  return true;
}

/** Marks the caller's session as fully authenticated (if it was waiting on MFA). */
async function completePendingSession(tx: TenantTx, actor: Actor): Promise<void> {
  const completed = await tx.session.updateMany({
    where: { id: actor.sessionId, tenantId: actor.tenantId, mfaPending: true },
    data: { mfaPending: false },
  });
  if (completed.count > 0) {
    // Deferred from login: the login is only complete now, so this is where the failure count resets.
    await tx.user.update({ where: { id: actor.userId }, data: { lastLoginAt: new Date(), failedLoginCount: 0 } });
  }
}

/**
 * Finishes enrollment: if `code` is valid, MFA is switched on and the caller's session (if it was
 * waiting on MFA) becomes fully authenticated.
 *
 * @throws ValidationError (field `code`) for a wrong code, InvalidStateTransitionError if enrollment was never started.
 */
export async function confirmMfaEnrollment(actor: Actor, code: string, client: ClientInfo): Promise<void> {
  enforceRateLimit(`mfa:session:${actor.sessionId}`, RATE_LIMITS.mfaPerSession);
  const valid = await withTenant(actor.tenantId, async (tx) => {
    const user = await loadUser(tx, actor);
    if (user.mfaEnabled) throw new ConflictError({ message: "Multi-factor authentication is already enabled." });
    if (!(await checkCode(tx, actor, code, client, { enrolling: true }))) return false;
    await tx.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    await completePendingSession(tx, actor);
    return true;
  });
  if (!valid) throw new ValidationError({ message: INVALID_CODE_MESSAGE, field: "code" });
}

/**
 * Login step 2: verifies a TOTP code and promotes the caller's `mfaPending` session.
 * Also usable on an already complete session as a step-up check (it just stays complete).
 *
 * @throws ValidationError (field `code`) for a wrong or reused code, RateLimitedError while locked or throttled.
 */
export async function verifyMfaChallenge(actor: Actor, code: string, client: ClientInfo): Promise<void> {
  enforceRateLimit(`mfa:session:${actor.sessionId}`, RATE_LIMITS.mfaPerSession);
  const valid = await withTenant(actor.tenantId, async (tx) => {
    const user = await loadUser(tx, actor);
    if (!user.mfaEnabled) {
      throw new InvalidStateTransitionError({ message: "Multi-factor authentication is not enabled; enroll first." });
    }
    if (!(await checkCode(tx, actor, code, client, { enrolling: false }))) return false;
    await completePendingSession(tx, actor);
    return true;
  });
  if (!valid) throw new ValidationError({ message: INVALID_CODE_MESSAGE, field: "code" });
}
