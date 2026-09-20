import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The credential that lets a scheduled job pull a backup.
 *
 * Why this exists at all: the database is deleted on a fixed date, has no
 * backups, and its IP allow-list is empty - so nothing outside Render can
 * connect to it, and `pg_dump` from CI is not available (see
 * server/backup.ts). The only route out is the application itself, which
 * means a scheduler has to be able to authenticate without a browser session.
 *
 * What it guards is the most sensitive response the product can produce: every
 * user's personal data and password hashes, in one file. So the rules here are
 * deliberately strict, and all of them fail closed.
 *
 * Kept as its own module, free of `server-only` and of Next's request scope,
 * so the comparison can be unit-tested. The route reads the environment; this
 * decides.
 */

/**
 * Shorter than this is refused outright, however exactly it matches.
 *
 * A short token is a guessable one, and an operator who sets
 * VELTO_BACKUP_TOKEN=secret should find that the backup endpoint stays shut
 * rather than discover later that it was open all along. 32 characters of
 * `openssl rand -hex 32` output is 128 bits; the check is on characters
 * because that is what a person pastes into a settings field.
 */
export const MIN_TOKEN_LENGTH = 32;

/**
 * Compare a presented token with the configured one.
 *
 * Both sides are hashed before comparison. That is not for secrecy - the
 * digest of a token is as good as the token to anyone holding it - but so the
 * comparison runs over two fixed-length buffers. Comparing the raw strings
 * would make the work depend on their lengths, which leaks the token's length
 * to anyone timing the endpoint, and `timingSafeEqual` throws outright when
 * the two buffers differ in size.
 *
 * Returns false, never throws, for every malformed case: no token configured,
 * a configured token that is too short to be worth anything, and no token
 * presented.
 */
export function tokenMatches(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return false;
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Pull the token out of an Authorization header.
 *
 * `Bearer <token>`, case-insensitive on the scheme because clients differ, and
 * null for anything else - including a bare token with no scheme, which is
 * usually a misconfigured client rather than a caller we want to serve.
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Whether token authentication is available at all.
 *
 * Used to tell "you presented the wrong token" apart from "this deployment
 * does not accept tokens" in the server log. The response is the same either
 * way - a caller learns nothing from us about whether the door exists.
 */
export function tokenAuthConfigured(expected: string | null | undefined): boolean {
  return !!expected && expected.length >= MIN_TOKEN_LENGTH;
}
