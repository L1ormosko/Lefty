/**
 * Opaque tokens for sessions, invitations and password resets.
 *
 * Format: `<tenantId>.<random>`. The tenant prefix is not secret; it lets us open the right
 * `withTenant` context before we can look the token up (those tables are RLS-protected). Only the
 * SHA-256 of the whole token is stored, so a database leak does not yield usable tokens. The
 * random part is 256 bits, so a fast hash is sufficient (no salt/stretching needed).
 */
import { createHash, randomBytes } from "node:crypto";

export interface IssuedToken {
  /** Give this to the user once; it is never stored. */
  token: string;
  tokenHash: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueToken(tenantId: string): IssuedToken {
  const token = `${tenantId}.${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashToken(token) };
}

/** Extracts the tenant id from a token, or null if it is not shaped like one of ours. */
export function tenantIdFromToken(token: string): string | null {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1 || token.length > 256) return null;
  return token.slice(0, separator);
}
