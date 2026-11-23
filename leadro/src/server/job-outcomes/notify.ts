import { resolveRecipientsByPermission, notifyInTx, registerNotificationTargetResolver } from "@/server/notifications";
import type { ResourceRef } from "@/server/authz";
import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { jobResourceRef } from "@/server/jobs";

/**
 * Outcome notifications (§9.1, §14.2). When a visit did not convert, the people who oversee outcomes in
 * the job's service area (`job_outcomes.edit` over the unit: managers; the technician who reported it
 * is excluded) hear about it. The notification links to the outcome and carries the job number only;
 * the link stays visible only while the recipient still holds `job_outcomes.view` over the job
 * (read-time check through the resolver below).
 */

/** The authorization attributes of an outcome are those of its job. */
export async function outcomeResourceRef(tx: TenantTx, tenantId: string, outcomeId: string): Promise<ResourceRef | null> {
  const outcome = await tx.jobOutcome.findFirst({ where: { id: outcomeId, tenantId }, select: { jobId: true } });
  return outcome ? jobResourceRef(tx, tenantId, outcome.jobId) : null;
}

/** Registers how notifications that link to an outcome are authorized at read time. Idempotent; called at module load. */
export function registerJobOutcomeNotificationTarget(): void {
  registerNotificationTargetResolver("job_outcome", "job_outcomes.view", (tx, subject, outcomeId) => outcomeResourceRef(tx, subject.tenantId, outcomeId));
}
registerJobOutcomeNotificationTarget();

/**
 * Tells the job's managers that a visit did not convert. Runs inside the recording transaction; the caller
 * hands the returned ids to `deliverAfterCommit`. Idempotent per outcome (`eventId` = outcome id).
 */
export async function notifyNotConverted(
  tx: TenantTx,
  actor: Actor,
  job: { id: string; number: number; orgUnitId: string },
  outcomeId: string,
): Promise<string[]> {
  const recipientUserIds = await resolveRecipientsByPermission(tx, actor.tenantId, {
    permissions: ["job_outcomes.edit"],
    orgUnitId: job.orgUnitId,
    excludeUserIds: [actor.userId],
  });
  if (recipientUserIds.length === 0) return [];
  const resource = await jobResourceRef(tx, actor.tenantId, job.id);
  const result = await notifyInTx(tx, {
    tenantId: actor.tenantId,
    eventType: "job.not_converted",
    eventId: outcomeId,
    recipientUserIds,
    params: { jobNumber: job.number },
    target: resource ? { targetType: "job_outcome", targetId: outcomeId, permission: "job_outcomes.view", resource } : undefined,
  });
  return result.createdNotificationIds;
}
