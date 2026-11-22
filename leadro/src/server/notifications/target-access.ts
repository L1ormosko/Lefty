import type { NotificationParams } from "@/lib/notification-rules";
import { canInTx, type ResourceRef } from "@/server/authz";
import type { TenantTx } from "@/server/db";

/** Template shown instead of a notification whose target the recipient may no longer see. */
export const UNAVAILABLE_TEMPLATE_KEY = "NOTIFICATION.ITEM_UNAVAILABLE";

/** Loads the authorization attributes of the target record from the database (never from the notification). */
export type TargetResolver = (tx: TenantTx, subject: { tenantId: string; userId: string }, targetId: string) => Promise<ResourceRef | null> | ResourceRef | null;

interface RegisteredTarget {
  /** The permission a viewer needs on the record for the notification to stay visible. */
  permission: string;
  resolve: TargetResolver;
}

const resolvers = new Map<string, RegisteredTarget>();

/**
 * Registers how to authorize the viewer of a notification that links to `targetType` (e.g. "lead",
 * "job"). The module that owns the record type calls this once at load. `resolve` returns the
 * record's ResourceRef (org unit, assigned employees, sets...) or null when the record is gone.
 * Until a type is registered its notifications fail closed: they are shown redacted.
 */
export function registerNotificationTargetResolver(targetType: string, permission: string, resolve: TargetResolver): void {
  resolvers.set(targetType, { permission, resolve });
}

/** Test hook: forget every registered resolver. */
export function resetNotificationTargetResolvers(): void {
  resolvers.clear();
}

/** The part of a notification that can reveal a record. */
export interface TargetedNotification {
  templateKey: string;
  params: NotificationParams;
  targetType: string | null;
  targetId: string | null;
}

/**
 * Read-time access check (ids in notifications are not proof of access): for every row that links
 * to a record, re-evaluates the recipient's CURRENT permission on that record. When it fails, is
 * unresolvable, the record is gone or the target type has no registered resolver, the row is
 * redacted: generic template, no params, no target. Rows without a target pass through untouched.
 * Revoking someone's role therefore hides lead/job numbers from notifications they already hold.
 */
export async function redactInaccessible<T extends TargetedNotification>(
  tx: TenantTx,
  tenantId: string,
  recipientUserId: string,
  rows: readonly T[],
): Promise<Array<T & { redacted: boolean }>> {
  const subject = { tenantId, userId: recipientUserId };
  const result: Array<T & { redacted: boolean }> = [];
  for (const row of rows) {
    if (row.targetId === null) {
      result.push({ ...row, redacted: false });
      continue;
    }
    const entry = row.targetType ? resolvers.get(row.targetType) : undefined;
    const resource = entry ? await entry.resolve(tx, subject, row.targetId) : null;
    const allowed = entry && resource ? (await canInTx(tx, subject, entry.permission, resource)).allowed : false;
    result.push(
      allowed
        ? { ...row, redacted: false }
        : { ...row, templateKey: UNAVAILABLE_TEMPLATE_KEY, params: {}, targetType: null, targetId: null, redacted: true },
    );
  }
  return result;
}

/** Write-time filter: the subset of `userIds` who may see the target record right now. */
export async function filterRecipientsWithAccess(
  tx: TenantTx,
  tenantId: string,
  userIds: readonly string[],
  permission: string,
  resource: ResourceRef,
): Promise<string[]> {
  const allowed: string[] = [];
  for (const userId of userIds) {
    if ((await canInTx(tx, { tenantId, userId }, permission, resource)).allowed) allowed.push(userId);
  }
  return allowed;
}
