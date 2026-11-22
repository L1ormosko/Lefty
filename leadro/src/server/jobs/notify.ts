import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { notifyInTx, registerNotificationTargetResolver, type NotificationEventType } from "@/server/notifications";
import { jobResourceRef } from "./job-access";

/**
 * Job notifications (§14.2): assigned, reassigned / unassigned, rescheduled, cancelled. Rows are
 * written inside the business transaction (`notifyInTx`); services hand the returned ids to
 * `deliverAfterCommit` once it committed.
 */

/**
 * Read-time access for notifications that link to a job: the recipient's CURRENT `jobs.view` over the
 * job decides whether they still see it. Called at module load (the notifications README requires the
 * owner of a record type to register its resolver) and exported so a test or a worker can re-register it.
 */
export function registerJobNotificationTarget(): void {
  registerNotificationTargetResolver("job", "jobs.view", (tx, subject, jobId) => jobResourceRef(tx, subject.tenantId, jobId));
}
registerJobNotificationTarget();

/** User ids of employees (employees without a login are skipped: there is nobody to notify). */
async function userIdsOfEmployees(tx: TenantTx, tenantId: string, employeeIds: readonly string[]): Promise<string[]> {
  if (employeeIds.length === 0) return [];
  const rows = await tx.employee.findMany({ where: { tenantId, id: { in: [...employeeIds] } }, select: { userId: true } });
  return rows.map((row) => row.userId).filter((userId): userId is string => userId !== null);
}

export interface JobNotification {
  eventType: Extract<NotificationEventType, "job.assigned" | "job.reassigned" | "job.rescheduled" | "job.cancelled">;
  job: { id: string; number: number };
  /** Names the occurrence (usually the assignment or job-event id) so a retried request notifies nobody twice. */
  anchor: string;
  employeeIds: readonly string[];
  /**
   * Attach the job as the notification's link target. Recipients without `jobs.view` over the job right
   * NOW are then dropped, so do not link events whose recipients just lost access (reassigned,
   * cancelled: those carry the job number only, which the recipient already knew).
   */
  link: boolean;
}

/** Notifies the users behind `employeeIds` (never the actor: they know). Returns the created notification ids. */
export async function notifyJobEmployees(tx: TenantTx, actor: Actor, notification: JobNotification): Promise<string[]> {
  const recipientUserIds = (await userIdsOfEmployees(tx, actor.tenantId, notification.employeeIds)).filter((userId) => userId !== actor.userId);
  if (recipientUserIds.length === 0) return [];
  const resource = notification.link ? await jobResourceRef(tx, actor.tenantId, notification.job.id) : null;
  const result = await notifyInTx(tx, {
    tenantId: actor.tenantId,
    eventType: notification.eventType,
    eventId: `${notification.job.id}:${notification.anchor}`,
    recipientUserIds,
    params: { jobNumber: notification.job.number },
    target: resource ? { targetType: "job", targetId: notification.job.id, permission: "jobs.view", resource } : undefined,
  });
  return result.createdNotificationIds;
}
