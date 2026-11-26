import type { TenantTx } from "@/server/db";
import { notifyInTx, registerNotificationTargetResolver, type NotificationEventType } from "@/server/notifications";

/**
 * Training notifications (§10.1, §5.8, §14.2): assigned, overdue, expiring, expired. They link to the assignment or the
 * record; recipients need `training.view` over the employee (the notification engine drops anyone without it, and
 * re-checks it at read time through the resolvers below). Rows are written inside the business transaction; callers hand
 * the returned ids to `deliverAfterCommit` once it committed.
 *
 * Limitation: an employee whose roles hold no `training.view` (a Dispatcher, say) is not notified here; their own
 * training is shown through self-service (`/api/v1/me/*`, Phase 5 Task 6).
 */

/** Read-time access: the recipient's CURRENT `training.view` over the employee decides. Idempotent. */
export function registerTrainingNotificationTargets(): void {
  registerNotificationTargetResolver("training_assignment", "training.view", async (tx, subject, assignmentId) => {
    const row = await tx.trainingAssignment.findFirst({ where: { id: assignmentId, tenantId: subject.tenantId }, select: { employeeId: true } });
    return row ? { employeeId: row.employeeId } : null;
  });
  registerNotificationTargetResolver("training_record", "training.view", async (tx, subject, recordId) => {
    const row = await tx.trainingRecord.findFirst({ where: { id: recordId, tenantId: subject.tenantId }, select: { employeeId: true } });
    return row ? { employeeId: row.employeeId } : null;
  });
}
registerTrainingNotificationTargets();

type TrainingEvent = Extract<NotificationEventType, "training.assigned" | "training.overdue" | "training.expiring" | "training.expired">;

/**
 * Notifies `recipientUserIds` (nulls and `excludeUserId` dropped) about an assignment or record of `employeeId`.
 * `anchor` names the occurrence (the due date, the expiry date) so a re-run sweep notifies nobody twice.
 * @returns the created notification ids
 */
export async function notifyTraining(
  tx: TenantTx,
  tenantId: string,
  notification: {
    eventType: TrainingEvent;
    targetId: string;
    employeeId: string;
    anchor: string;
    recipientUserIds: ReadonlyArray<string | null>;
    excludeUserId?: string | null;
  },
): Promise<string[]> {
  const recipients = [...new Set(notification.recipientUserIds.filter((id): id is string => id !== null && id !== notification.excludeUserId))];
  if (recipients.length === 0) return [];
  const targetType = notification.eventType === "training.assigned" || notification.eventType === "training.overdue" ? "training_assignment" : "training_record";
  const result = await notifyInTx(tx, {
    tenantId,
    eventType: notification.eventType,
    eventId: `${notification.targetId}:${notification.anchor}`,
    recipientUserIds: recipients,
    target: { targetType, targetId: notification.targetId, permission: "training.view", resource: { employeeId: notification.employeeId } },
  });
  return result.createdNotificationIds;
}
