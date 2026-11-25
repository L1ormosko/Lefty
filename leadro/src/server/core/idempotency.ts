import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenant } from "@/server/db";
import { serializeJson } from "@/lib/money";
import { logger } from "@/server/logging";
import { ConflictError, ValidationError } from "./errors";

/** Completed responses are replayable for 24 h (docs/API_CONVENTIONS.md). */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * How long an unfinished claim blocks duplicates. Short on purpose: if the process dies after
 * claiming, the client can retry after this window instead of being locked out for 24 h.
 */
export const IDEMPOTENCY_IN_FLIGHT_MS = 2 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** What identifies "the same request": who sent it + method + path + body. */
export interface IdempotencyScope {
  /** Keys are private to the user who sent them: another user reusing a key never sees this response. */
  actorUserId: string;
  method: string;
  path: string;
  body: unknown;
}

/** The response to store and replay. `body` must be JSON-serialisable. */
export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export interface IdempotentOutcome extends IdempotentResponse {
  /** True when the stored response was returned and `fn` did not run. */
  replayed: boolean;
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` hash identically. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

export function hashIdempotentRequest(scope: IdempotencyScope): string {
  return createHash("sha256")
    .update(canonicalJson({ actorUserId: scope.actorUserId, method: scope.method.toUpperCase(), path: scope.path, body: scope.body }))
    .digest("hex");
}

type ClaimResult =
  | { kind: "claimed"; recordId: string }
  | { kind: "replay"; response: IdempotentResponse };

/**
 * Runs `fn` at most once per (tenant, user, key) within 24 h and replays its stored response to
 * duplicates (§20.3).
 *
 * - Same key, same request, finished  -> stored status/body returned, `fn` NOT run.
 * - Same key, different request       -> CONFLICT (a client bug; never silently run something else).
 * - Same key, still running elsewhere -> CONFLICT, retryable (the concurrent duplicate case).
 * - `fn` throws                       -> the claim is released so the client may retry.
 *
 * The claim is committed in its own short transaction BEFORE `fn` runs, so concurrent duplicates
 * see it immediately; `INSERT ... ON CONFLICT DO NOTHING` makes exactly one of them the winner.
 * `fn` runs outside that transaction and does its own `withTenant` work.
 */
export async function withIdempotency(
  tenantId: string,
  key: string,
  scope: IdempotencyScope,
  fn: () => Promise<IdempotentResponse>,
): Promise<IdempotentOutcome> {
  if (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ValidationError({
      message: `Idempotency-Key must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
      field: "Idempotency-Key",
    });
  }
  const requestHash = hashIdempotentRequest(scope);
  // The table is unique per (tenant, key); prefixing the user id makes it unique per (tenant, user, key)
  // without a schema change. The prefixed value is storage-only; the client's key is never altered.
  const storedKey = `${scope.actorUserId}:${key}`;

  const claim = await claimKey(tenantId, storedKey, scope, requestHash);
  if (claim.kind === "replay") return { ...claim.response, replayed: true };

  let response: IdempotentResponse;
  try {
    response = await fn();
  } catch (error) {
    await releaseClaim(tenantId, claim.recordId);
    throw error;
  }
  try {
    await storeResponse(tenantId, claim.recordId, response);
  } catch (storeError) {
    // fn already succeeded and its effects are committed: report that truth to the client instead
    // of a 500 that invites a retry. The claim expires after IDEMPOTENCY_IN_FLIGHT_MS; until then
    // duplicates get a retryable CONFLICT.
    logger.error("failed to store idempotent response", { recordId: claim.recordId, storeError: String(storeError) });
  }
  return { ...response, replayed: false };
}

async function claimKey(
  tenantId: string,
  key: string,
  scope: IdempotencyScope,
  requestHash: string,
): Promise<ClaimResult> {
  return withTenant(tenantId, async (tx) => {
    const now = new Date();
    // Expired records (finished >24 h ago, or abandoned in-flight claims) no longer count.
    await tx.idempotencyRecord.deleteMany({ where: { tenantId, key, expiresAt: { lt: now } } });

    const recordId = randomUUID();
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_IN_FLIGHT_MS);
    const inserted = await tx.$executeRaw`
      INSERT INTO "IdempotencyRecord" ("id", "tenantId", "key", "method", "path", "requestHash", "expiresAt")
      VALUES (${recordId}, ${tenantId}, ${key}, ${scope.method.toUpperCase()}, ${scope.path}, ${requestHash}, ${expiresAt})
      ON CONFLICT ("tenantId", "key") DO NOTHING`;
    if (inserted === 1) return { kind: "claimed", recordId } as const;

    const existing = await tx.idempotencyRecord.findUnique({ where: { tenantId_key: { tenantId, key } } });
    if (!existing) {
      // The other holder released or expired between our INSERT and SELECT; let the client retry.
      throw new ConflictError({ message: "A request with this Idempotency-Key is in progress.", retryable: true });
    }
    if (existing.requestHash !== requestHash) {
      throw new ConflictError({
        message: "This Idempotency-Key was already used with a different request.",
        field: "Idempotency-Key",
      });
    }
    if (existing.responseStatus === null) {
      throw new ConflictError({ message: "A request with this Idempotency-Key is in progress.", retryable: true });
    }
    return {
      kind: "replay",
      response: { status: existing.responseStatus, body: existing.responseBody },
    } as const;
  });
}

async function storeResponse(tenantId: string, recordId: string, response: IdempotentResponse): Promise<void> {
  // updateMany (not update): if the claim expired and a duplicate already took it over, there is
  // nothing to update and that must not turn a successful request into an error. Handlers are
  // expected to finish well within IDEMPOTENCY_IN_FLIGHT_MS (withTenant caps transactions at 15 s).
  await withTenant(tenantId, (tx) =>
    tx.idempotencyRecord.updateMany({
      where: { id: recordId },
      data: {
        responseStatus: response.status,
        // Prisma rejects a plain null for Json columns; an empty body is stored as JSON null.
        responseBody: response.body == null ? Prisma.JsonNull : (serializeJson(response.body) as Prisma.InputJsonValue),
        expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
      },
    }),
  );
}

async function releaseClaim(tenantId: string, recordId: string): Promise<void> {
  try {
    await withTenant(tenantId, (tx) => tx.idempotencyRecord.deleteMany({ where: { id: recordId } }));
  } catch (releaseError) {
    // Not fatal: the claim expires after IDEMPOTENCY_IN_FLIGHT_MS. Never mask the original error.
    logger.warn("failed to release idempotency claim", { recordId, releaseError: String(releaseError) });
  }
}
