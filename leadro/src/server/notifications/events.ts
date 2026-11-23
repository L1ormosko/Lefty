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
  "lead.follow_up_due": { templateKey: "NOTIFICATION.LEAD_FOLLOW_UP_DUE", critical: false, targetType: "lead", params: ["leadNumber"] },
  "job.assigned": { templateKey: "NOTIFICATION.JOB_ASSIGNED", critical: false, targetType: "job", params: ["jobNumber"] },
  "job.reassigned": { templateKey: "NOTIFICATION.JOB_REASSIGNED", critical: false, targetType: "job", params: ["jobNumber"] },
  "job.rescheduled": { templateKey: "NOTIFICATION.JOB_RESCHEDULED", critical: false, targetType: "job", params: ["jobNumber"] },
  "job.cancelled": { templateKey: "NOTIFICATION.JOB_CANCELLED", critical: true, targetType: "job", params: ["jobNumber"] },
  "job.not_converted": { templateKey: "NOTIFICATION.JOB_NOT_CONVERTED", critical: false, targetType: "job_outcome", params: ["jobNumber"] },
  "qualification.expiring": { templateKey: "NOTIFICATION.QUALIFICATION_EXPIRING", critical: false, targetType: "employee_qualification", params: ["daysRemaining"] },
  "qualification.expired": { templateKey: "NOTIFICATION.QUALIFICATION_EXPIRED", critical: true, targetType: "employee_qualification", params: [] },
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
