import { AsyncLocalStorage } from "node:async_hooks";
import type { FieldEvent, Prisma } from "@prisma/client";
import { checkOccurredAt, findCoordinateKey } from "@/lib/location-rules";
import { ConflictError, InvalidStateTransitionError, ValidationError, type AppError } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { logger } from "@/server/logging";

/**
 * The offline gate for field writes (spec 8.7, 25.3). A device may send the same event twice (retry, flaky network,
 * sync after being offline); the server must apply it once and answer the same way every time.
 *
 * The key is `(tenant, employee, clientEventId)` (unique index on `FieldEvent`). The first submission is claimed
 * with `INSERT ... ON CONFLICT DO NOTHING`, so two concurrent copies serialise on the index: the second waits for the
 * first to commit and then sees its row. A later copy is classified by the stored `payloadHash`:
 *  - same hash, `ACCEPTED`: a REPLAY. The work is NOT repeated; `replay` rebuilds the original answer from the
 *    entity the first run created;
 *  - same hash, `REJECTED`: the original refusal is raised again (the stored code), so a retry never "succeeds" later;
 *  - different hash: `409 CONFLICT`. A clientEventId names ONE event; reusing it for different content is a client bug.
 * Business refusals (validation, state, conflict) of a NEW event are stored (unless the error is `retryable`: a state-ordering refusal such as "not EN_ROUTE yet", so the device can resend after the earlier event synced) as `REJECTED` in a second transaction,
 * because the first one rolled back with the failed work. Permission denials are never stored: they are not facts
 * about the event, and the caller may be allowed later.
 *
 * Payloads hold ids and enum values only. Coordinates must never be stored here (ERD "Contracts for JSON"), so a
 * payload with a coordinate-looking key is a programming error and throws.
 */

export interface FieldEventRequest {
  tenantId: string;
  employeeId: string;
  actorUserId: string;
  /** Dotted lower-case key: `shift.start`, `shift.end`, `location.departure`, ... */
  type: string;
  clientEventId: string;
  /** When it happened on the device (events are applied in this order by the sync endpoint). */
  occurredAt: Date;
  /** sha256 of the event's meaning (`hashFieldEventContent`). */
  payloadHash: string;
  payload?: Prisma.InputJsonObject;
  deviceId?: string;
  batchId?: string;
  jobId?: string;
  /**
   * Detail code of the 409 raised when this id was already used for different content. Defaults to
   * `CLIENT_EVENT_ID_REUSED`; job-outcomes keeps its published `field_event.payload_mismatch`.
   */
  reusedIdCode?: string;
}

/** What the event created or changed, recorded so a replay can find it again. */
export interface FieldEventEntity {
  type: string;
  id: string;
  shiftId?: string;
}

export interface FieldEventHandlers<T> {
  /** First delivery: does the work in the claim's transaction and says what it produced. */
  apply: (tx: TenantTx, fieldEventId: string) => Promise<{ result: T; entity: FieldEventEntity }>;
  /** Later delivery of an ACCEPTED event: rebuilds the original answer from the stored entity. */
  replay: (tx: TenantTx, entity: FieldEventEntity) => Promise<T>;
}

export interface FieldEventOutcome<T> {
  result: T;
  /** True when this was a repeated delivery and nothing was applied again. */
  replayed: boolean;
}

/** Rejections worth remembering: the same input would be refused again, so a replay should be refused identically. */
const STORED_REFUSALS = ["VALIDATION_FAILED", "INVALID_STATE_TRANSITION", "CONFLICT"] as const;
type StoredRefusal = (typeof STORED_REFUSALS)[number];

const isStoredRefusal = (error: unknown): error is AppError & { code: StoredRefusal } =>
  typeof error === "object" && error !== null && "code" in error && STORED_REFUSALS.includes((error as AppError).code as StoredRefusal);

/**
 * `resultCode` is the error code, plus ":" and the first detail code when the refusal had one (`CONFLICT:completion.already_submitted`),
 * so a replay answers with the same machine-readable reason the first delivery got.
 */
const resultCodeOf = (error: AppError): string => (error.details?.[0]?.code ? `${error.code}:${error.details[0].code}` : error.code);

function refusalFromCode(stored: string): Error {
  const [code, detailCode] = stored.split(":", 2);
  const message = "This event was refused when it was first received. Send a corrected event with a new clientEventId.";
  const options = { message, ...(detailCode ? { details: [{ field: "clientEventId", code: detailCode, message }] } : {}) };
  if (code === "INVALID_STATE_TRANSITION") return new InvalidStateTransitionError(options);
  if (code === "CONFLICT") return new ConflictError(options);
  return new ValidationError(options);
}

/** Conflicts raised for a reused id are not stored as refusals (the stored event is the first one, and stays valid). */
const reusedIdConflicts = new WeakSet<AppError>();

const DEFAULT_REUSED_ID_CODE = "CLIENT_EVENT_ID_REUSED";

function sameContentConflict(code: string = DEFAULT_REUSED_ID_CODE): ConflictError {
  const error = new ConflictError({
    message: "This clientEventId was already used for a different event.",
    field: "clientEventId",
    details: [{ field: "clientEventId", code, message: "Use a new clientEventId for a different event." }],
  });
  reusedIdConflicts.add(error);
  return error;
}

const batchContext = new AsyncLocalStorage<string>();

/** Runs `work` so every FieldEvent row it CREATES carries `batchId` (used by the sync endpoint). */
export const withFieldEventBatch = <T>(batchId: string, work: () => Promise<T>): Promise<T> => batchContext.run(batchId, work);

/** Inserts the event row if nobody has; returns the row either way and whether this call inserted it. */
async function claim(tx: TenantTx, request: FieldEventRequest, result: "ACCEPTED" | "REJECTED", resultCode?: string): Promise<{ row: FieldEvent; inserted: boolean }> {
  const offending = request.payload ? findCoordinateKey(request.payload) : null;
  if (offending) throw new Error(`Field event payload must not contain coordinates (found "${offending}")`);
  const { count } = await tx.fieldEvent.createMany({
    data: [
      {
        tenantId: request.tenantId,
        employeeId: request.employeeId,
        actorUserId: request.actorUserId,
        clientEventId: request.clientEventId,
        type: request.type,
        jobId: request.jobId,
        deviceId: request.deviceId,
        // The batch of the sync call in progress labels the rows IT creates (a replayed event keeps its first batch).
        batchId: request.batchId ?? batchContext.getStore(),
        occurredAt: request.occurredAt,
        payload: request.payload,
        payloadHash: request.payloadHash,
        result,
        resultCode,
      },
    ],
    skipDuplicates: true,
  });
  const row = await tx.fieldEvent.findFirstOrThrow({
    where: { tenantId: request.tenantId, employeeId: request.employeeId, clientEventId: request.clientEventId },
  });
  return { row, inserted: count === 1 };
}

/**
 * Runs `apply` at most once per `(employee, clientEventId)` and answers repeats from the stored result (see the file
 * comment). `apply` runs in the same transaction as the claim, so a failure leaves nothing behind.
 */
export async function runFieldEvent<T>(request: FieldEventRequest, handlers: FieldEventHandlers<T>): Promise<FieldEventOutcome<T>> {
  try {
    return await withTenant(request.tenantId, async (tx) => {
      const { row, inserted } = await claim(tx, request, "ACCEPTED");
      if (!inserted) {
        if (row.payloadHash !== request.payloadHash) throw sameContentConflict(request.reusedIdCode);
        if (row.result !== "ACCEPTED") throw refusalFromCode(row.resultCode ?? "VALIDATION_FAILED");
        if (!row.entityType || !row.entityId) throw new ConflictError({ message: "This event is still being processed. Retry shortly.", retryable: true });
        return { result: await handlers.replay(tx, { type: row.entityType, id: row.entityId, shiftId: row.shiftId ?? undefined }), replayed: true };
      }
      // The device time is judged on FIRST delivery only: a late replay of an accepted event must still be answered.
      // A time ahead of the server clock is retryable (it becomes valid); one older than a week is a stored verdict.
      const problem = checkOccurredAt(request.occurredAt, new Date());
      if (problem !== null) {
        throw new ValidationError({ message: "The event time is in the future or too old to accept.", field: "occurredAt", retryable: problem === "IN_THE_FUTURE" });
      }
      const { result, entity } = await handlers.apply(tx, row.id);
      await tx.fieldEvent.update({
        where: { id: row.id },
        data: { entityType: entity.type, entityId: entity.id, shiftId: entity.shiftId },
      });
      return { result, replayed: false };
    });
  } catch (error) {
    // A refusal marked retryable depends on the ORDER events arrive in (e.g. "job not EN_ROUTE yet"): it must not stick to the id.
    if (isStoredRefusal(error) && !isReusedIdConflict(error) && !error.retryable) await rememberRefusal(request, resultCodeOf(error));
    throw error;
  }
}

const isReusedIdConflict = (error: AppError): boolean => reusedIdConflicts.has(error);

/** Stores the refusal in its own transaction; a failure here must not hide the original error. */
async function rememberRefusal(request: FieldEventRequest, code: string): Promise<void> {
  try {
    await withTenant(request.tenantId, async (tx) => {
      // A row already exists when this refusal is itself a replay (or a concurrent copy stored it): nothing to add.
      const existing = await tx.fieldEvent.findFirst({
        where: { tenantId: request.tenantId, employeeId: request.employeeId, clientEventId: request.clientEventId },
        select: { id: true },
      });
      if (!existing) await claim(tx, request, "REJECTED", code);
    });
  } catch (error) {
    // The caller still gets the original refusal; without the stored row a retry is judged afresh. Never swallow silently.
    logger.error("could not store a refused field event", { tenantId: request.tenantId, type: request.type, code, error: String(error) });
  }
}
