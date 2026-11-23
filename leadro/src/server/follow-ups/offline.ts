import { createHash } from "node:crypto";
import type { FieldEvent, Prisma } from "@prisma/client";
import {
  AppError,
  ConflictError,
  InvalidStateTransitionError,
  ValidationError,
  isUniqueViolation,
  type Actor,
  type ErrorCode,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";

/**
 * Offline-safe field writes (§8.7, §25.3). A write that carries a `clientEventId` is recorded in `FieldEvent`, idempotent per
 * (tenant, employee, clientEventId):
 *
 *  - first time: the write runs and its `FieldEvent` (ACCEPTED) commits in the SAME transaction;
 *  - the same id again with the same content: nothing runs, the stored result is returned (`replay`);
 *  - the same id with different content (`payloadHash` differs): 409, nothing changes;
 *  - a write refused for a business reason (invalid transition, validation, conflict) is stored as REJECTED, so a replay
 *    answers with the same error code instead of being re-evaluated against a state that has moved on. Permission failures
 *    are NOT stored: they can be fixed (a role granted) and the device may retry the same event.
 *
 * Without a `clientEventId` the write simply runs. Coordinates never go here (they live in `LocationEvent` only); the
 * payload holds ids and codes, free text stays in the domain row.
 */

export interface OfflineFields {
  clientEventId?: string;
  /** When it happened on the device. Defaults to now; a time in the future is refused. */
  occurredAt?: Date;
}

export interface FieldWriteSpec {
  /** Dotted lower-case event type, e.g. `follow_up.complete`. */
  type: string;
  /** EVERYTHING that defines the event (including free text): hashed, never stored. */
  content: unknown;
  /** Ids and enum values stored in `FieldEvent.payload`. */
  payload: Record<string, string | number | boolean | null>;
}

/** What `run` returns: the affected row, the answer for the caller, and notifications to deliver after commit. */
export interface FieldWriteOutcome<T> {
  entityType: string;
  entityId: string;
  value: T;
  notificationIds: string[];
}

/** Clock skew tolerated for a client-supplied `occurredAt`. */
const FUTURE_SKEW_MS = 60_000;
/** Errors that are a verdict on the event, not on the caller's rights: stored as REJECTED. */
const STORED_REJECTIONS: readonly ErrorCode[] = ["VALIDATION_FAILED", "CONFLICT", "INVALID_STATE_TRANSITION"];

/** The error a stored REJECTED verdict is answered with on replay (same class and code as the first answer). */
function rejectionError(code: string | null): AppError {
  const options = { message: "This event was rejected when it was first received." };
  if (code === "VALIDATION_FAILED") return new ValidationError(options);
  if (code === "INVALID_STATE_TRANSITION") return new InvalidStateTransitionError(options);
  return new ConflictError(options);
}

/** JSON with sorted keys, so the same content always hashes the same. Dates become ISO strings. */
function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** `occurredAt` is the CLIENT's time (undefined when it sent none: "now" differs on every retry and must not enter the hash). */
export const hashFieldEvent = (spec: FieldWriteSpec, occurredAt: Date | undefined): string =>
  createHash("sha256").update(canonicalJson({ type: spec.type, content: spec.content, occurredAt })).digest("hex");

/**
 * Runs a field write. `run(tx, occurredAt)` does the work inside the transaction and returns the outcome; `replay(tx, entityId)`
 * rebuilds the answer of an already accepted event (the entity as it is now, re-checked for the caller's access).
 */
export async function runFieldWrite<T>(
  actor: Actor,
  offline: OfflineFields,
  spec: FieldWriteSpec,
  run: (tx: TenantTx, occurredAt: Date) => Promise<FieldWriteOutcome<T>>,
  replay: (tx: TenantTx, entityId: string) => Promise<T>,
): Promise<T> {
  const now = new Date();
  const occurredAt = offline.occurredAt ?? now;
  if (occurredAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    throw new ValidationError({ message: "An event cannot happen in the future.", field: "occurredAt" });
  }

  if (!offline.clientEventId) {
    const outcome = await withTenant(actor.tenantId, (tx) => run(tx, occurredAt));
    await deliverAfterCommit(actor.tenantId, outcome.notificationIds);
    return outcome.value;
  }
  if (!actor.employeeId) {
    throw new ValidationError({ message: "Offline events need an employee record.", field: "clientEventId" });
  }
  const identity = { tenantId: actor.tenantId, employeeId: actor.employeeId, clientEventId: offline.clientEventId };
  const payloadHash = hashFieldEvent(spec, offline.occurredAt);

  // A concurrent twin can win the unique (tenant, employee, clientEventId) between our lookup and insert: it aborts this
  // transaction, and the second attempt then finds the twin's row and replays it.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptOnce();
    } catch (error) {
      if (!(isUniqueViolation(error) && attempt === 1)) throw error;
    }
  }

  async function attemptOnce(): Promise<T> {
    // Filled inside the transaction callback (a holder object, so TypeScript does not narrow the fields to their initial null).
    const state: { outcome: FieldWriteOutcome<T> | null; existing: FieldEvent | null } = { outcome: null, existing: null };
    try {
      await withTenant(actor.tenantId, async (tx) => {
        state.existing = await tx.fieldEvent.findFirst({ where: identity });
        if (state.existing) return;
        const outcome = await run(tx, occurredAt);
        state.outcome = outcome;
        await tx.fieldEvent.create({
          data: {
            ...identity,
            actorUserId: actor.userId,
            type: spec.type,
            occurredAt,
            payload: spec.payload as Prisma.InputJsonObject,
            payloadHash,
            result: "ACCEPTED",
            entityType: outcome.entityType,
            entityId: outcome.entityId,
          },
        });
      });
    } catch (error) {
      if (error instanceof AppError && STORED_REJECTIONS.includes(error.code)) {
        // A twin of this event may have committed while we waited on its row lock: its verdict stands, ours is moot.
        const twin = await storeRejection(error.code);
        if (twin) return answerReplay(twin);
      }
      throw error;
    }
    if (state.outcome) {
      await deliverAfterCommit(actor.tenantId, state.outcome.notificationIds);
      return state.outcome.value;
    }
    return answerReplay(state.existing);
  }

  /** Stores the verdict; returns the event that already exists when a twin got there first, else null. */
  async function storeRejection(code: ErrorCode): Promise<FieldEvent | null> {
    try {
      await withTenant(actor.tenantId, (tx) =>
        tx.fieldEvent.create({
          data: { ...identity, actorUserId: actor.userId, type: spec.type, occurredAt, payload: spec.payload as Prisma.InputJsonObject, payloadHash, result: "REJECTED", resultCode: code },
        }),
      );
      return null;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return withTenant(actor.tenantId, (tx) => tx.fieldEvent.findFirst({ where: identity }));
    }
  }

  async function answerReplay(event: FieldEvent | null): Promise<T> {
    if (!event) throw new ConflictError({ message: "The event could not be recorded. Retry it." });
    if (event.payloadHash !== payloadHash || event.type !== spec.type) {
      throw new ConflictError({ message: "This clientEventId was already used for a different event.", field: "clientEventId" });
    }
    if (event.result === "ACCEPTED" && event.entityId) {
      const entityId = event.entityId;
      return withTenant(actor.tenantId, (tx) => replay(tx, entityId));
    }
    throw rejectionError(event.resultCode);
  }
}
