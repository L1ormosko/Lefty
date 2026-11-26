import type { Prisma } from "@prisma/client";
import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import type { JobStatusValue } from "@/lib/job-lifecycle";

/**
 * The job's own trails (§7.2, §21): `JobStatusHistory` (one row per status change) and `JobEvent`
 * (everything else that happens to the job). Both tables are append-only (DB triggers), written in
 * the same transaction as the change they describe.
 */

/** The actor of a trail row; `null` = the system (automatic steps such as CREATED > PENDING_ASSIGNMENT). */
export type TrailActor = Pick<Actor, "userId"> | null;

export async function recordStatusHistory(
  tx: TenantTx,
  tenantId: string,
  jobId: string,
  change: { from: JobStatusValue | null; to: JobStatusValue; actor: TrailActor; reason?: string | null; occurredAt?: Date },
): Promise<string> {
  const row = await tx.jobStatusHistory.create({
    data: {
      tenantId,
      jobId,
      fromStatus: change.from,
      toStatus: change.to,
      actorType: change.actor ? "USER" : "SYSTEM",
      actorUserId: change.actor?.userId ?? null,
      reason: change.reason ?? null,
      ...(change.occurredAt ? { occurredAt: change.occurredAt } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Appends a job event. `type` is a dotted lower-case key (`job.assigned`, `job.rescheduled`...).
 * Payloads carry ids, statuses and field NAMES, never money or free text from other modules.
 * @returns the event id (used as the idempotency anchor of notifications).
 */
export async function recordJobEvent(
  tx: TenantTx,
  tenantId: string,
  jobId: string,
  event: { type: string; actor: TrailActor; payload?: Prisma.InputJsonObject },
): Promise<string> {
  const row = await tx.jobEvent.create({
    data: {
      tenantId,
      jobId,
      type: event.type,
      actorType: event.actor ? "USER" : "SYSTEM",
      actorUserId: event.actor?.userId ?? null,
      payload: event.payload,
    },
    select: { id: true },
  });
  return row.id;
}
