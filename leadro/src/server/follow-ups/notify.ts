import type { TenantTx } from "@/server/db";
import { notifyInTx, registerNotificationTargetResolver, type NotificationEventType } from "@/server/notifications";
import { canViewTarget, followUpResourceRef, loadFollowUpRow } from "./access";
import type { FollowUpRow } from "./fields";

/**
 * Follow-up notifications (§14.2): assigned, due soon, overdue. All go to the task's assignee and link to the task.
 * Rows are written inside the business transaction (`notifyInTx`); callers hand the returned ids to
 * `deliverAfterCommit` once it committed.
 */

/**
 * Read-time access for notifications that link to a follow-up: the recipient's CURRENT `follow_ups.view` over the task
 * decides, and so does their access to the task's target (a task about a lead they lost access to is redacted).
 * Registered when the module loads and from `src/server/notification-targets.ts`; idempotent.
 */
export function registerFollowUpNotificationTarget(): void {
  registerNotificationTargetResolver("follow_up", "follow_ups.view", async (tx, subject, followUpId) => {
    const row = await loadFollowUpRow(tx, subject.tenantId, followUpId);
    if (!row || !(await canViewTarget(tx, subject, row))) return null;
    return followUpResourceRef(row);
  });
}
registerFollowUpNotificationTarget();

export interface FollowUpNotification {
  eventType: Extract<NotificationEventType, "follow_up.assigned" | "follow_up.due_soon" | "follow_up.overdue">;
  row: FollowUpRow;
  /** Names the occurrence (assignment time, due time) so a retried request or a re-run sweep notifies nobody twice. */
  anchor: string;
  /** The assignee's own actions are not notified (they know). */
  excludeUserId?: string | null;
}

/**
 * Notifies the task's assignee, if there is one with a login who may still see the task AND its target. Returns the
 * created notification ids (empty when nobody was notified).
 */
export async function notifyFollowUpAssignee(tx: TenantTx, tenantId: string, notification: FollowUpNotification): Promise<string[]> {
  const { row } = notification;
  if (!row.assigneeId) return [];
  const employee = await tx.employee.findFirst({ where: { id: row.assigneeId, tenantId }, select: { userId: true } });
  const userId = employee?.userId;
  if (!userId || userId === notification.excludeUserId) return [];
  if (!(await canViewTarget(tx, { tenantId, userId }, row))) return [];
  const result = await notifyInTx(tx, {
    tenantId,
    eventType: notification.eventType,
    eventId: `${row.id}:${notification.anchor}`,
    recipientUserIds: [userId],
    target: { targetType: "follow_up", targetId: row.id, permission: "follow_ups.view", resource: followUpResourceRef(row) },
  });
  return result.createdNotificationIds;
}
