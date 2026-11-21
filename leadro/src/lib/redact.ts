/**
 * Pure redaction of sensitive values from arbitrary JSON-like data.
 *
 * Shared by the audit engine (§21.2: "sensitive values must be redacted") and the structured
 * logger, so both apply the same rules. Framework-free: no Prisma, no Next.
 */

export const REDACTED = "[REDACTED]";

/**
 * Key fragments that mark a value as sensitive. Keys are normalised (lower-case, letters and digits
 * only) before matching, so `passwordHash`, `password_hash` and `PASSWORD-HASH` all match "password".
 * We deliberately over-redact (e.g. `tokenCount`): a missing value in a log is cheap, a leaked
 * secret is not.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "passcode",
  "secret", // mfaSecret, clientSecret, signingSecret
  "token", // sessionToken, refreshToken, resetToken
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "privatekey",
  "recoverycode",
];

// Guards against cyclic or absurdly deep structures.
const MAX_DEPTH = 8;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a property with this name must never be stored or logged in clear text. */
export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * Returns a deep copy of `value` that is safe to serialise as JSON: sensitive properties are
 * replaced by `"[REDACTED]"`, Dates become ISO strings, BigInts become strings, and `undefined`
 * properties are dropped. The input is never mutated.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";

  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    result[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(child, depth + 1);
  }
  return result;
}
