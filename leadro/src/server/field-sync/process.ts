import { ZodError } from "zod";
import { AppError, ForbiddenError, zodIssuesToFieldIssues, type Actor, type FieldIssue, type RequestContext } from "@/server/core";
import { logger } from "@/server/logging";
import { withFieldEventBatch } from "@/server/field-events";
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
      return { status: "CONFLICT", retryable: error.retryable };
    case "VALIDATION_FAILED":
    case "INVALID_STATE_TRANSITION":
      // `retryable` marks refusals caused by ORDER or configuration (the job is not EN_ROUTE yet, no form published yet):
      // the gate does not remember them, so the same event may be sent again once the cause is gone.
      return { status: "REJECTED", retryable: error.retryable };
    case "NOT_FOUND":
      // A job not (yet) assigned to the caller: not remembered, may become visible later.
      return { status: "FORBIDDEN", retryable: true };
    case "FORBIDDEN":
    case "UNAUTHENTICATED":
      // A permission or field-set refusal ("amount without the financial set") does not change by waiting.
      return { status: "FORBIDDEN", retryable: error.retryable };
    default:
      return { status: "FAILED", retryable: true };
  }
}

/** The services report a repeated delivery themselves (`replayed`); the sync reads that instead of looking the row up first. */
const wasReplayed = (result: unknown): boolean => typeof result === "object" && result !== null && (result as { replayed?: unknown }).replayed === true;

async function applyOne(actor: Actor, ctx: RequestContext, batchId: string, event: FieldSyncEvent, index: number, sequence: number): Promise<SyncEventResult> {
  const base = { index, clientEventId: event.clientEventId, type: event.type, sequence };
  const handler = findFieldSyncHandler(event.type);
  if (!handler) {
    return { ...base, status: "UNSUPPORTED", code: "UNSUPPORTED_EVENT_TYPE", message: `The server does not know the event type "${event.type}".`, retryable: false };
  }
  try {
    const result = await withFieldEventBatch(batchId, () => handler({ actor, ctx, event }));
    return { ...base, status: wasReplayed(result) ? "REPLAYED" : "ACCEPTED", retryable: false, result };
  } catch (error) {
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

  const ordered = batch.events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.occurredAt.getTime() - right.event.occurredAt.getTime() || left.index - right.index);

  const results: SyncEventResult[] = [];
  let sequence = 0;
  for (const { event, index } of ordered) {
    sequence += 1;
    results.push(await applyOne(actor, ctx, batch.batchId, event, index, sequence));
  }
  results.sort((left, right) => left.index - right.index);

  const summary = { total: results.length, accepted: 0, replayed: 0, rejected: 0, conflict: 0, forbidden: 0, unsupported: 0, failed: 0 };
  for (const result of results) summary[result.status.toLowerCase() as Lowercase<SyncStatus>] += 1;
  return { batchId: batch.batchId, receivedAt: new Date().toISOString(), summary, results };
}
