import type { NotificationParams } from "@/lib/notification-rules";
import type { ResourceRef } from "@/server/authz";

/**
 * The business events that produce notifications (§14.2). Each entry fixes the translation key
 * (title = `<templateKey>.TITLE`, body = `<templateKey>.BODY`, in all three catalogs), whether the
 * event is critical (ignores opt-outs, §14.1) and which record the notification links to.
 *
 * To add an event: add a row here, add the two keys to en-US/es-US/he-IL, call `notifyInTx`.
 * Params of a template are interpolated into the BODY, so list them in `params` for the next reader.
 */
export const NOTIFICATION_EVENTS = {
  "lead.assigned": { templateKey: "NOTIFICATION.LEAD_ASSIGNED", critical: false, targetType: "lead", params: ["leadNumber"] },
  "lead.needs_owner": { templateKey: "NOTIFICATION.LEAD_NEEDS_OWNER", critical: false, targetType: "lead", params: ["leadNumber"] },
  "job.assigned": { templateKey: "NOTIFICATION.JOB_ASSIGNED", critical: false, targetType: "job", params: ["jobNumber"] },
  "job.reassigned": { templateKey: "NOTIFICATION.JOB_REASSIGNED", critical: false, targetType: "job", params: ["jobNumber"] },
  "job.rescheduled": { templateKey: "NOTIFICATION.JOB_RESCHEDULED", critical: false, targetType: "job", params: ["jobNumber"] },
  "job.cancelled": { templateKey: "NOTIFICATION.JOB_CANCELLED", critical: true, targetType: "job", params: ["jobNumber"] },
  // Follow-up tasks (§5.6, §5.9): the notification links to the task itself; text carries no params (a task title is free text).
  "follow_up.assigned": { templateKey: "NOTIFICATION.FOLLOW_UP_ASSIGNED", critical: false, targetType: "follow_up", params: [] },
  "follow_up.due_soon": { templateKey: "NOTIFICATION.FOLLOW_UP_DUE_SOON", critical: false, targetType: "follow_up", params: [] },
  "follow_up.overdue": { templateKey: "NOTIFICATION.FOLLOW_UP_OVERDUE", critical: false, targetType: "follow_up", params: [] },
  "job.arrival_unverified": { templateKey: "NOTIFICATION.JOB_ARRIVAL_UNVERIFIED", critical: false, targetType: "job", params: ["jobNumber"] },
  "job.not_converted": { templateKey: "NOTIFICATION.JOB_NOT_CONVERTED", critical: false, targetType: "job_outcome", params: ["jobNumber"] },
  // Lead recovery (§9.3): Lead Operations hear about a new case. Links to the case; the text carries only its number.
  "recovery.case_created": { templateKey: "NOTIFICATION.RECOVERY_CASE_CREATED", critical: false, targetType: "recovery_case", params: ["caseNumber"] },
  "recovery.case_assigned": { templateKey: "NOTIFICATION.RECOVERY_CASE_ASSIGNED", critical: false, targetType: "recovery_case", params: ["caseNumber"] },
  // Approvals (§21.3): eligible approvers hear about a new request; the requester hears how it ended. No params: the text
  // never carries the subject or the amount, the linked request shows them to whoever may still see it.
  "approval.requested": { templateKey: "NOTIFICATION.APPROVAL_REQUESTED", critical: false, targetType: "approval_request", params: [] },
  "approval.decided": { templateKey: "NOTIFICATION.APPROVAL_DECIDED", critical: false, targetType: "approval_request", params: [] },
  "account.security_alert": { templateKey: "NOTIFICATION.SECURITY_ALERT", critical: true, targetType: null, params: [] },
} as const;

export type NotificationEventType = keyof typeof NOTIFICATION_EVENTS;

export const isNotificationEventType = (value: string): value is NotificationEventType =>
  Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENTS, value);

/** What a service hands to `notifyInTx` inside its business transaction. */
export interface NotificationEvent {
  /** Must be the tenant the transaction was opened for (`withTenant`); RLS rejects anything else. */
  tenantId: string;
  eventType: NotificationEventType;
  /**
   * The business event it came from, e.g. the lead id plus the transition (`<leadId>:assigned:<assignmentId>`).
   * Together with `eventType` it is the default idempotency key: notifying the same event twice
   * (a retried request, a re-run job) creates nothing the second time.
   */
  eventId: string;
  /** User ids (not employee ids). Duplicates are merged; inactive users are skipped. */
  recipientUserIds: readonly string[];
  /** Ids, numbers and codes only: see `findParamsProblem`. */
  params?: NotificationParams;
  /**
   * The record the notification links to, with what is needed to authorize recipients: recipients
   * without `permission` on `resource` (the ResourceRef authz needs: orgUnitId, assignedEmployeeIds,
   * sets...) are dropped. `targetType` must equal the event's registered target type. Omit for events
   * without a record (e.g. a security alert).
   */
  target?: { targetType: string; targetId: string; permission: string; resource: ResourceRef };
  /** Override only when one event may legitimately notify the same user twice. */
  idempotencyKey?: string;
}
