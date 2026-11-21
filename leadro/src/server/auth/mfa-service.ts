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
import { LOCKOUT_DURATION_MS, MFA_ISSUER, RATE_LIMITS } from "./config";
import type { ClientInfo } from "./client-info";
import { recordAuthEvent } from "./events";
import { isLockedOut, lockIfTooManyFailures } from "./lockout";
import { enforceRateLimit } from "./rate-limiter";
import { decryptSecret, encryptSecret } from "./secret-box";
import { issueToken } from "./tokens";

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
  // Replay guard: accept a step only if it is newer than the last accepted one. Doing it as one
  // conditional UPDATE (not read-then-write) means two concurrent requests with the same code
  // cannot both pass: the second waits for the row lock, re-evaluates the WHERE and matches nothing.
  // It also refuses older in-window steps after a newer one was used.
  const alreadyUsed =
    timeStep !== null &&
    (await tx.user.updateMany({
      where: { id: user.id, tenantId: actor.tenantId, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: timeStep } }] },
      data: { mfaLastUsedStep: timeStep },
    })).count === 0;

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

/** Replacement session credentials handed out when an MFA-pending session becomes a full one. */
export interface PromotedSession {
  /** The new raw token; the cookie must be replaced with it. The pending token no longer works. */
  token: string;
  expiresAt: Date;
}

/**
 * Marks the caller's session as fully authenticated (if it was waiting on MFA) and ROTATES its
 * token. The pre-MFA token may have been exposed in places the post-MFA one must not be (session
 * fixation hardening), so the privilege change gets a fresh secret. The row, its id and its
 * absolute expiry stay the same.
 * @returns the new credentials, or null when the session was not pending (nothing changed).
 */
async function promotePendingSession(tx: TenantTx, actor: Actor): Promise<PromotedSession | null> {
  const { token, tokenHash } = issueToken(actor.tenantId);
  const promoted = await tx.session.updateMany({
    where: { id: actor.sessionId, tenantId: actor.tenantId, mfaPending: true },
    data: { mfaPending: false, tokenHash },
  });
  if (promoted.count === 0) return null;
  // Deferred from login: the login is only complete now, so this is where the failure count resets.
  await tx.user.update({ where: { id: actor.userId }, data: { lastLoginAt: new Date(), failedLoginCount: 0 } });
  const session = await tx.session.findUniqueOrThrow({ where: { id: actor.sessionId }, select: { expiresAt: true } });
  return { token, expiresAt: session.expiresAt };
}

/**
 * Finishes enrollment: if `code` is valid, MFA is switched on and the caller's session (if it was
 * waiting on MFA) becomes fully authenticated under a new token.
 *
 * @returns the rotated session credentials, or null if the session was already complete.
 * @throws ValidationError (field `code`) for a wrong code, InvalidStateTransitionError if enrollment was never started.
 */
export async function confirmMfaEnrollment(actor: Actor, code: string, client: ClientInfo): Promise<PromotedSession | null> {
  enforceRateLimit(`mfa:session:${actor.sessionId}`, RATE_LIMITS.mfaPerSession);
  const outcome = await withTenant(actor.tenantId, async (tx) => {
    const user = await loadUser(tx, actor);
    if (user.mfaEnabled) throw new ConflictError({ message: "Multi-factor authentication is already enabled." });
    if (!(await checkCode(tx, actor, code, client, { enrolling: true }))) return { valid: false as const };
    await tx.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    return { valid: true as const, promoted: await promotePendingSession(tx, actor) };
  });
  if (!outcome.valid) throw new ValidationError({ message: INVALID_CODE_MESSAGE, field: "code" });
  return outcome.promoted;
}

/**
 * Login step 2: verifies a TOTP code and promotes the caller's `mfaPending` session (new token).
 * Also usable on an already complete session as a step-up check (it just stays complete).
 *
 * @returns the rotated session credentials, or null if the session was already complete.
 * @throws ValidationError (field `code`) for a wrong or reused code, RateLimitedError while locked or throttled.
 */
export async function verifyMfaChallenge(actor: Actor, code: string, client: ClientInfo): Promise<PromotedSession | null> {
  enforceRateLimit(`mfa:session:${actor.sessionId}`, RATE_LIMITS.mfaPerSession);
  const outcome = await withTenant(actor.tenantId, async (tx) => {
    const user = await loadUser(tx, actor);
    if (!user.mfaEnabled) {
      throw new InvalidStateTransitionError({ message: "Multi-factor authentication is not enabled; enroll first." });
    }
    if (!(await checkCode(tx, actor, code, client, { enrolling: false }))) return { valid: false as const };
    return { valid: true as const, promoted: await promotePendingSession(tx, actor) };
  });
  if (!outcome.valid) throw new ValidationError({ message: INVALID_CODE_MESSAGE, field: "code" });
  return outcome.promoted;
}
