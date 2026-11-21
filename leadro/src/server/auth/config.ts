/**
 * Authentication policy constants (§22.1 secure authentication, session controls, lockout).
 * They are code constants on purpose: changing a security limit should be a reviewed change.
 */

export const SESSION_COOKIE_NAME = "leadro_session";

/** A session unused for this long is dead, even if its absolute lifetime has not ended. */
export const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** A session never lives longer than this, however active; forces a fresh login (and MFA). */
export const SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** `lastSeenAt` is only rewritten when older than this, so reads do not become writes. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export const BCRYPT_COST = 12;
export const PASSWORD_MIN_LENGTH = 12;
/** bcrypt silently ignores bytes past 72, so longer passwords are refused instead of truncated. */
export const PASSWORD_MAX_BYTES = 72;

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export const MFA_ISSUER = "LEADRO";

/** Fixed-window rate limits, see rate-limiter.ts. */
export const RATE_LIMITS = {
  loginPerIp: { limit: 30, windowMs: 60 * 1000 },
  loginPerAccount: { limit: 10, windowMs: 60 * 1000 },
  mfaPerSession: { limit: 10, windowMs: 60 * 1000 },
  passwordResetPerIp: { limit: 10, windowMs: 15 * 60 * 1000 },
  passwordResetPerAccount: { limit: 3, windowMs: 15 * 60 * 1000 },
  passwordResetConfirmPerIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  invitationAcceptPerIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  passwordChangePerAccount: { limit: 5, windowMs: 15 * 60 * 1000 },
} as const;
