import { randomUUID } from "node:crypto";
import type { NotificationChannel as ChannelKind, Prisma } from "@prisma/client";
import { findParamsProblem, isChannelOptedOut } from "@/lib/notification-rules";
import { ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "./events";

const ID_LIKE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RECIPIENTS = 500;

export interface NotifyResult {
  /** Ids of notifications created by THIS call (empty when everything was a duplicate). */
  createdNotificationIds: string[];
  /** Recipients that already had this event (idempotent no-ops). */
  duplicateCount: number;
  /** Recipients dropped because they are not active users of the tenant. */
  skippedRecipientCount: number;
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
 * @throws ValidationError when `params` break the ids-only contract (a programming error: fix the caller).
 */
export async function notifyInTx(tx: TenantTx, event: NotificationEvent): Promise<NotifyResult> {
  const { tenantId } = event;
  const definition = NOTIFICATION_EVENTS[event.eventType];
  const params = event.params ?? {};
  const paramsProblem = findParamsProblem(params);
  if (paramsProblem) throw new ValidationError({ message: `Notification params rejected: ${paramsProblem}`, field: "params" });
  if (!ID_LIKE.test(event.eventId)) throw new ValidationError({ message: "Notification eventId must be an identifier.", field: "eventId" });
  const idempotencyKey = event.idempotencyKey ?? `${event.eventType}:${event.eventId}`;
  if (idempotencyKey.length > 200) throw new ValidationError({ message: "Notification idempotencyKey is too long.", field: "idempotencyKey" });

  const requested = [...new Set(event.recipientUserIds)];
  if (requested.length > MAX_RECIPIENTS) throw new ValidationError({ message: `At most ${MAX_RECIPIENTS} recipients per event.`, field: "recipientUserIds" });
  const recipients = await tx.user.findMany({
    where: { tenantId, id: { in: requested }, status: "ACTIVE" },
    select: { id: true },
  });
  const skippedRecipientCount = requested.length - recipients.length;
  if (recipients.length === 0) return { createdNotificationIds: [], duplicateCount: 0, skippedRecipientCount };
  const recipientIds = recipients.map((recipient) => recipient.id);

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
      targetType: event.targetId ? definition.targetType : null,
      targetId: event.targetId ?? null,
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
