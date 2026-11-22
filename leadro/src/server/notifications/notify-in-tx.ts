import { randomUUID } from "node:crypto";
import type { NotificationChannel as ChannelKind, Prisma } from "@prisma/client";
import { findParamsProblem, isChannelOptedOut } from "@/lib/notification-rules";
import { ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { logger } from "@/server/logging";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "./events";
import { filterRecipientsWithAccess } from "./target-access";

const ID_LIKE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RECIPIENTS = 500;

export interface NotifyResult {
  /** Ids of notifications created by THIS call (empty when everything was a duplicate). */
  createdNotificationIds: string[];
  /** Recipients that already had this event (idempotent no-ops). */
  duplicateCount: number;
  /** Recipients dropped because they are not active users of the tenant. */
  skippedRecipientCount: number;
  /** Recipients dropped because they may not see the target record (`target.permission` on `target.resource`). */
  inaccessibleRecipientCount: number;
}

/**
 * Records a notification for each recipient INSIDE the caller's business transaction (§14), so the
 * notification exists if and only if the business change commits. It writes rows only; sending
 * happens after commit in `deliverPending` / `deliverAfterCommit`, so a provider failure can never
 * roll the business change back.
 *
 * Per recipient it creates one `Notification` and one `NotificationDelivery` (attempt 1) per
 * channel: IN_APP always, plus the tenant's other enabled channels. For non-critical events a
 * recipient's opted-out channel gets a SKIPPED row (a truthful record, nothing is sent); critical
 * events ignore opt-outs (§14.1). IN_APP is the inbox itself and cannot be opted out of.
 *
 * Idempotent: the unique `(recipient, idempotencyKey)` (default `<eventType>:<eventId>`) makes a
 * repeated call a no-op for recipients already notified. `ON CONFLICT DO NOTHING` is used so a race
 * between two transactions cannot abort either one.
 *
 * Access: when the event links to a record (`event.target`), a recipient for whom
 * `canInTx(target.permission, target.resource)` fails is silently dropped (counted and logged), so
 * a record's existence and number never reach someone outside its scope. Read time re-checks too
 * (`redactInaccessible`).
 *
 * @throws ValidationError on programming errors: params that are undeclared, missing or not ids-only,
 *   a bad eventId/targetId, a target type that does not match the event. It propagates into the
 *   caller's transaction and rolls it back, which is intended: fix the caller.
 */
export async function notifyInTx(tx: TenantTx, event: NotificationEvent): Promise<NotifyResult> {
  const { tenantId } = event;
  const definition = NOTIFICATION_EVENTS[event.eventType];
  const params = event.params ?? {};
  const declared: readonly string[] = definition.params;
  const undeclared = Object.keys(params).filter((name) => !declared.includes(name));
  const missing = declared.filter((name) => !(name in params));
  if (undeclared.length > 0 || missing.length > 0) {
    throw new ValidationError({
      message: `Notification params for ${event.eventType} must be exactly [${declared.join(", ")}] (undeclared: [${undeclared.join(", ")}], missing: [${missing.join(", ")}]).`,
      field: "params",
    });
  }
  const paramsProblem = findParamsProblem(params);
  if (paramsProblem) throw new ValidationError({ message: `Notification params rejected: ${paramsProblem}`, field: "params" });
  if (!ID_LIKE.test(event.eventId)) throw new ValidationError({ message: "Notification eventId must be an identifier.", field: "eventId" });
  const idempotencyKey = event.idempotencyKey ?? `${event.eventType}:${event.eventId}`;
  if (idempotencyKey.length > 200) throw new ValidationError({ message: "Notification idempotencyKey is too long.", field: "idempotencyKey" });

  const target = event.target;
  if (target) {
    if (!ID_LIKE.test(target.targetId)) throw new ValidationError({ message: "Notification targetId must be an identifier.", field: "target.targetId" });
    if (target.targetType !== definition.targetType) {
      throw new ValidationError({ message: `Event ${event.eventType} links to ${definition.targetType ?? "no record"}, not ${target.targetType}.`, field: "target.targetType" });
    }
  }

  const requested = [...new Set(event.recipientUserIds)];
  if (requested.length > MAX_RECIPIENTS) throw new ValidationError({ message: `At most ${MAX_RECIPIENTS} recipients per event.`, field: "recipientUserIds" });
  const recipients = await tx.user.findMany({
    where: { tenantId, id: { in: requested }, status: "ACTIVE" },
    select: { id: true },
  });
  const skippedRecipientCount = requested.length - recipients.length;
  const recipientIds = target
    ? await filterRecipientsWithAccess(tx, tenantId, recipients.map((recipient) => recipient.id), target.permission, target.resource)
    : recipients.map((recipient) => recipient.id);
  const inaccessibleRecipientCount = recipients.length - recipientIds.length;
  if (inaccessibleRecipientCount > 0) {
    logger.info("notification recipients dropped: no access to the target record", { tenantId, eventType: event.eventType, dropped: inaccessibleRecipientCount });
  }
  if (recipientIds.length === 0) return { createdNotificationIds: [], duplicateCount: 0, skippedRecipientCount, inaccessibleRecipientCount };

  // Ids are generated here so we know afterwards which rows THIS call inserted (createMany skips duplicates).
  const candidates = recipientIds.map((recipientId) => ({ id: randomUUID(), recipientId }));
  await tx.notification.createMany({
    data: candidates.map(({ id, recipientId }) => ({
      id,
      tenantId,
      recipientId,
      eventType: event.eventType,
      eventId: event.eventId,
      idempotencyKey,
      templateKey: definition.templateKey,
      params: Object.keys(params).length > 0 ? (params as Prisma.InputJsonObject) : undefined,
      targetType: target ? target.targetType : null,
      targetId: target ? target.targetId : null,
      critical: definition.critical,
    })),
    skipDuplicates: true,
  });
  const stored = await tx.notification.findMany({
    where: { tenantId, recipientId: { in: recipientIds }, idempotencyKey },
    select: { id: true },
  });
  const storedIds = new Set(stored.map((row) => row.id));
  const created = candidates.filter((candidate) => storedIds.has(candidate.id));

  if (created.length > 0) await createFirstAttempts(tx, tenantId, event.eventType, definition.critical, created);
  return {
    createdNotificationIds: created.map((candidate) => candidate.id),
    duplicateCount: recipientIds.length - created.length,
    skippedRecipientCount,
    inaccessibleRecipientCount,
  };
}

/** Delivery rows, attempt 1: PENDING per enabled channel, SKIPPED where a non-critical event was opted out. */
async function createFirstAttempts(
  tx: TenantTx,
  tenantId: string,
  eventType: string,
  critical: boolean,
  created: Array<{ id: string; recipientId: string }>,
): Promise<void> {
  const settings = await tx.operationsSettings.findUnique({ where: { tenantId }, select: { enabledChannels: true } });
  // No settings row means the defaults: in-app only.
  const enabled = settings?.enabledChannels ?? ["IN_APP"];
  const channels: ChannelKind[] = ["IN_APP", ...enabled.filter((channel) => channel !== "IN_APP")];

  // All rows, not only opt-outs: an `enabled: true` row for one event overrides a `*` opt-out.
  const preferences = critical
    ? []
    : await tx.notificationPreference.findMany({
        where: { tenantId, userId: { in: created.map((row) => row.recipientId) } },
        select: { userId: true, eventType: true, channel: true, enabled: true },
      });
  const rowsOf = (userId: string) => preferences.filter((row) => row.userId === userId);

  await tx.notificationDelivery.createMany({
    data: created.flatMap(({ id, recipientId }) =>
      channels.map((channel) => {
        const skipped = channel !== "IN_APP" && !critical && isChannelOptedOut(rowsOf(recipientId), eventType, channel);
        return { tenantId, notificationId: id, channel, attempt: 1, status: skipped ? ("SKIPPED" as const) : ("PENDING" as const) };
      }),
    ),
  });
}
