import type { JobStatusValue } from "@/lib/job-lifecycle";
import type { TenantTx } from "@/server/db";

/**
 * The domain event "a job changed status", published by `changeJobStatus` INSIDE the changing transaction, so the change
 * and everything a subscriber derives from it (the finance module's review flag when a job with posted money is reopened,
 * spec 11.7 / 25.4) commit or roll back together. Same pattern as `onJobOutcomeRecorded` in job-outcomes.
 *
 * Payload: ids and statuses only. `statusHistoryId` identifies the change (a deterministic anchor for idempotent reactions).
 */
export interface JobStatusChangedEvent {
  tenantId: string;
  jobId: string;
  from: JobStatusValue;
  to: JobStatusValue;
  /** The `JobStatusHistory` row written for this change. */
  statusHistoryId: string;
  /** The change started the job's next visit (the previous visit already has an outcome). */
  startedNextVisit: boolean;
  /** The person who decided the change; null for an automatic step. */
  actorUserId: string | null;
}

export type JobStatusChangedHandler = (tx: TenantTx, event: JobStatusChangedEvent) => Promise<void>;

// One Map on globalThis so the instrumentation bundle and the route bundles share it (ARCHITECTURE.md "Registries").
const globalForHandlers = globalThis as unknown as { leadroJobStatusHandlers?: Map<string, JobStatusChangedHandler> };
const handlers: Map<string, JobStatusChangedHandler> = (globalForHandlers.leadroJobStatusHandlers ??= new Map<string, JobStatusChangedHandler>());

/**
 * Subscribes `handler` (once per `name`; registering the same name again replaces it, so re-registration at load is safe).
 * A handler that throws aborts the status change: subscribe only handlers whose failure should block it.
 */
export function onJobStatusChanged(name: string, handler: JobStatusChangedHandler): void {
  handlers.set(name, handler);
}

/** Test hook: forget one subscriber (or all). */
export function resetJobStatusHandlers(name?: string): void {
  if (name) handlers.delete(name);
  else handlers.clear();
}

export async function publishJobStatusChanged(tx: TenantTx, event: JobStatusChangedEvent): Promise<void> {
  for (const handler of handlers.values()) await handler(tx, event);
}
