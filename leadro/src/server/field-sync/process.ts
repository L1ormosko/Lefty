import { ZodError } from "zod";
import { AppError, ForbiddenError, zodIssuesToFieldIssues, type Actor, type FieldIssue, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { logger } from "@/server/logging";
import { findFieldSyncHandler, type FieldSyncEvent } from "./registry";
import type { SyncBatchInput } from "./schemas";

/**
 * Applies a batch of offline field events (§8.7, §25.3).
 *
 *  - Events are applied in `occurredAt` order, stable by the order the device sent them (a start-work must precede its
 *    note even if the device queued them the other way round).
 *  - Each event goes through its module's service, which uses the shared offline gate: a duplicate is a REPLAYED success,
 *    the same `clientEventId` with other content is a CONFLICT, a business refusal is remembered as REJECTED.
 *  - One event never aborts the batch: every failure becomes that event's result and the next event is applied. Each event
 *    runs in its own transaction(s), so a failure leaves nothing half-done.
 *  - The batch id is written onto every event's `FieldEvent` row (when it has one) for per-batch reporting.
 *  - Results come back in the order the device sent the events (`index`), with `sequence` telling the order of application.
 */

export const SYNC_STATUSES = ["ACCEPTED", "REPLAYED", "REJECTED", "CONFLICT", "FORBIDDEN", "UNSUPPORTED", "FAILED"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export interface SyncEventResult {
  /** Position in the request, so the device can match results to what it sent. */
  index: number;
  clientEventId: string;
  type: string;
  /** Position in the order the server applied the events (by `occurredAt`). */
  sequence: number;
  status: SyncStatus;
  /** Stable machine code of the refusal (`VALIDATION_FAILED`, `CONFLICT`, ...); absent on success. */
  code?: string;
  message?: string;
  details?: FieldIssue[];
  /** The device may send this same event again later (a permission or a server problem, not a verdict on the event). */
  retryable: boolean;
  /** What the REST endpoint of this type would have answered; only on success. */
  result?: unknown;
}

export interface SyncBatchResult {
  batchId: string;
  receivedAt: string;
  summary: Record<Lowercase<SyncStatus> | "total", number>;
  results: SyncEventResult[];
}

/** AppError codes that are a verdict on the event (stored by the gate), mapped to the result status. */
function statusOfError(error: AppError): { status: SyncStatus; retryable: boolean } {
  switch (error.code) {
    case "CONFLICT":
      // "still being processed" (retryable) is also a CONFLICT: the device retries it.
      return { status: "CONFLICT", retryable: error.retryable };
    case "VALIDATION_FAILED":
    case "INVALID_STATE_TRANSITION":
      return { status: "REJECTED", retryable: false };
    case "FORBIDDEN":
    case "NOT_FOUND":
    case "UNAUTHENTICATED":
      // Not stored: the caller may gain access (a job assigned, a role granted) and send it again.
      return { status: "FORBIDDEN", retryable: true };
    default:
      return { status: "FAILED", retryable: true };
  }
}

/** Writes the batch id on the event's FieldEvent row when it has one and none is set yet (a replay keeps its first batch). */
async function stampBatch(actor: Actor, employeeId: string, clientEventId: string, batchId: string): Promise<void> {
  try {
    await withTenant(actor.tenantId, (tx) =>
      tx.fieldEvent.updateMany({ where: { tenantId: actor.tenantId, employeeId, clientEventId, batchId: null }, data: { batchId } }),
    );
  } catch (error) {
    // The event itself was applied; losing its batch label must not turn a success into a failure.
    logger.error("could not stamp the sync batch id", { tenantId: actor.tenantId, error: String(error) });
  }
}

async function wasAlreadyAccepted(actor: Actor, employeeId: string, clientEventId: string): Promise<boolean> {
  const earlier = await withTenant(actor.tenantId, (tx) =>
    tx.fieldEvent.findFirst({ where: { tenantId: actor.tenantId, employeeId, clientEventId }, select: { result: true } }),
  );
  return earlier?.result === "ACCEPTED";
}

async function applyOne(actor: Actor, ctx: RequestContext, employeeId: string, batchId: string, event: FieldSyncEvent, index: number, sequence: number): Promise<SyncEventResult> {
  const base = { index, clientEventId: event.clientEventId, type: event.type, sequence };
  const handler = findFieldSyncHandler(event.type);
  if (!handler) {
    return { ...base, status: "UNSUPPORTED", code: "UNSUPPORTED_EVENT_TYPE", message: `The server does not know the event type "${event.type}".`, retryable: false };
  }
  try {
    const alreadyAccepted = await wasAlreadyAccepted(actor, employeeId, event.clientEventId);
    const result = await handler({ actor, ctx, event });
    await stampBatch(actor, employeeId, event.clientEventId, batchId);
    return { ...base, status: alreadyAccepted ? "REPLAYED" : "ACCEPTED", retryable: false, result };
  } catch (error) {
    // The gate may have stored a REJECTED row for this attempt: label it too.
    await stampBatch(actor, employeeId, event.clientEventId, batchId);
    if (error instanceof ZodError) {
      return { ...base, status: "REJECTED", code: "VALIDATION_FAILED", message: "The event's payload is invalid.", details: zodIssuesToFieldIssues(error), retryable: false };
    }
    if (error instanceof AppError) {
      const { status, retryable } = statusOfError(error);
      return { ...base, status, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), retryable };
    }
    logger.error("field sync event failed", { tenantId: actor.tenantId, type: event.type, error: String(error) });
    return { ...base, status: "FAILED", code: "INTERNAL", message: "The event could not be processed. Try again.", retryable: true };
  }
}

/** Applies one batch for the calling employee. Only an employee can sync: a device belongs to one. */
export async function processFieldSyncBatch(actor: Actor, ctx: RequestContext, batch: SyncBatchInput): Promise<SyncBatchResult> {
  if (!actor.employeeId) throw new ForbiddenError({ message: "Only an employee can sync field events." });
  const employeeId = actor.employeeId;

  const ordered = batch.events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.occurredAt.getTime() - right.event.occurredAt.getTime() || left.index - right.index);

  const results: SyncEventResult[] = [];
  let sequence = 0;
  for (const { event, index } of ordered) {
    sequence += 1;
    results.push(await applyOne(actor, ctx, employeeId, batch.batchId, event, index, sequence));
  }
  results.sort((left, right) => left.index - right.index);

  const summary = { total: results.length, accepted: 0, replayed: 0, rejected: 0, conflict: 0, forbidden: 0, unsupported: 0, failed: 0 };
  for (const result of results) summary[result.status.toLowerCase() as Lowercase<SyncStatus>] += 1;
  return { batchId: batch.batchId, receivedAt: new Date().toISOString(), summary, results };
}
