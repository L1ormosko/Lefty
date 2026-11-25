import type { JobOutcomeTypeValue } from "@/lib/job-outcome-rules";
import type { TenantTx } from "@/server/db";

/**
 * The domain event "a visit outcome was recorded" (§9.3: the recovery engine reacts to it). Besides the
 * `job.outcome_recorded` / `job.not_converted` rows in the job's event log, in-process subscribers
 * (the recovery engine, Task 6) register a handler that runs INSIDE the recording transaction, so the
 * outcome and everything derived from it commit or roll back together.
 *
 * Payload: ids and enum values only, never free text or money (docs/ERD.md "Contracts for JSON").
 */
export interface OutcomeRecordedEvent {
  tenantId: string;
  jobId: string;
  outcomeId: string;
  visitNumber: number;
  outcome: JobOutcomeTypeValue;
  lostReasonId: string | null;
  /** The reason's `recoverable` flag (null when the outcome has no reason). */
  lostReasonRecoverable: boolean | null;
  /** NOT_SOLD / WORK_NOT_POSSIBLE: the visit did not convert (`job.not_converted`). */
  notConverted: boolean;
  customerRequestedFollowUp: boolean;
  /** Recorded after the fact for a job already past its visit (its status did not change). */
  retroactive: boolean;
  /** The job's status right after the outcome was applied. */
  jobStatus: string;
}

export type OutcomeRecordedHandler = (tx: TenantTx, event: OutcomeRecordedEvent) => Promise<void>;

// Same pattern as the notification target registry: one Map on globalThis so instrumentation and route bundles share it.
const globalForHandlers = globalThis as unknown as { leadroOutcomeHandlers?: Map<string, OutcomeRecordedHandler> };
const handlers: Map<string, OutcomeRecordedHandler> = (globalForHandlers.leadroOutcomeHandlers ??= new Map<string, OutcomeRecordedHandler>());

/**
 * Subscribes `handler` (once per `name`: registering the same name again replaces it, so re-registration at load is safe).
 * A handler that throws aborts the recording transaction: register only handlers whose failure should block the outcome.
 */
export function onJobOutcomeRecorded(name: string, handler: OutcomeRecordedHandler): void {
  handlers.set(name, handler);
}

/** Test hook: forget every subscriber. */
export function resetJobOutcomeHandlers(): void {
  handlers.clear();
}

export async function publishOutcomeRecorded(tx: TenantTx, event: OutcomeRecordedEvent): Promise<void> {
  for (const handler of handlers.values()) await handler(tx, event);
}

/**
 * The domain event "a recorded outcome was corrected" (§9.1, §25.4), published INSIDE the correcting transaction. The finance
 * module subscribes to flag a correction of an outcome whose money was already posted (the ledger is never rewritten; finance
 * decides on an adjustment). `jobEventId` (the `job.outcome_corrected` event row) identifies the correction.
 * Payload: ids and field NAMES only, never money or free text.
 */
export interface OutcomeCorrectedEvent {
  tenantId: string;
  jobId: string;
  outcomeId: string;
  jobEventId: string;
  changedFields: string[];
  actorUserId: string;
}

export type OutcomeCorrectedHandler = (tx: TenantTx, event: OutcomeCorrectedEvent) => Promise<void>;

const globalForCorrections = globalThis as unknown as { leadroOutcomeCorrectedHandlers?: Map<string, OutcomeCorrectedHandler> };
const correctionHandlers: Map<string, OutcomeCorrectedHandler> = (globalForCorrections.leadroOutcomeCorrectedHandlers ??= new Map<string, OutcomeCorrectedHandler>());

/** Subscribes `handler` once per `name` (re-registering replaces it). A throwing handler aborts the correction. */
export function onJobOutcomeCorrected(name: string, handler: OutcomeCorrectedHandler): void {
  correctionHandlers.set(name, handler);
}

/** Test hook: forget one correction subscriber (or all). */
export function resetOutcomeCorrectedHandlers(name?: string): void {
  if (name) correctionHandlers.delete(name);
  else correctionHandlers.clear();
}

export async function publishOutcomeCorrected(tx: TenantTx, event: OutcomeCorrectedEvent): Promise<void> {
  for (const handler of correctionHandlers.values()) await handler(tx, event);
}
