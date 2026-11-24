import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { jobResourceRef } from "@/server/jobs";
import { notifyInTx, resolveRecipientsByPermission } from "@/server/notifications";

/**
 * Tells the people who verify arrivals (`location.approve` over the job's service-area unit; the technician is
 * excluded) that an arrival could not be confirmed by the server and needs a decision (§17.4). Runs inside the
 * recording transaction; the caller hands the returned ids to `deliverAfterCommit`. Idempotent per arrival.
 * The notification links to the job (record type `job`, authorized at read time by the jobs module's resolver)
 * and carries the job number only: no position, no distance.
 */
export async function notifyArrivalNeedsReview(tx: TenantTx, actor: Actor, job: { id: string; number: number; orgUnitId: string }, arrivalId: string): Promise<string[]> {
  const recipientUserIds = await resolveRecipientsByPermission(tx, actor.tenantId, {
    permissions: ["location.approve"],
    orgUnitId: job.orgUnitId,
    excludeUserIds: [actor.userId],
  });
  if (recipientUserIds.length === 0) return [];
  const resource = await jobResourceRef(tx, actor.tenantId, job.id);
  const result = await notifyInTx(tx, {
    tenantId: actor.tenantId,
    eventType: "job.arrival_unverified",
    eventId: arrivalId,
    recipientUserIds,
    params: { jobNumber: job.number },
    target: resource ? { targetType: "job", targetId: job.id, permission: "jobs.view", resource } : undefined,
  });
  return result.createdNotificationIds;
}
