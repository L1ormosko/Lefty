import type { NotificationChannel as ChannelKind } from "@prisma/client";
import { ALL_EVENTS } from "@/lib/notification-rules";
import { ValidationError, type Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import { enforceInTx } from "@/server/authz";
import { NOTIFICATION_EVENTS, isNotificationEventType } from "./events";
import type { SetPreferenceInput } from "./schemas";

export interface PreferenceView {
  eventType: string;
  channel: ChannelKind;
  enabled: boolean;
}

/**
 * The caller's stored preferences. Absent rows mean "enabled", so this lists only what the user
 * changed. Critical events are never listed as switchable: see `setOwnPreference`.
 */
export async function listOwnPreferences(actor: Actor): Promise<PreferenceView[]> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "notifications.view");
    return tx.notificationPreference.findMany({
      where: { tenantId: actor.tenantId, userId: actor.userId },
      orderBy: [{ eventType: "asc" }, { channel: "asc" }],
      select: { eventType: true, channel: true, enabled: true },
    });
  });
}

/**
 * Opt in or out of one channel for one event type, or for every non-critical event (`*`). Only
 * non-critical events can be opted out of (§14.1): refusing here is clearer than storing a row
 * that would be ignored. Opting back in stores `enabled: true` (it can override a `*` opt-out).
 */
export async function setOwnPreference(actor: Actor, input: SetPreferenceInput): Promise<PreferenceView> {
  if (input.eventType !== ALL_EVENTS && isNotificationEventType(input.eventType) && NOTIFICATION_EVENTS[input.eventType].critical) {
    throw new ValidationError({ message: "Critical notifications cannot be switched off.", field: "eventType" });
  }
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "notifications.edit");
    const key = { tenantId: actor.tenantId, userId: actor.userId, eventType: input.eventType, channel: input.channel };
    const row = await tx.notificationPreference.upsert({
      where: { tenantId_userId_eventType_channel: key },
      create: { ...key, enabled: input.enabled },
      update: { enabled: input.enabled },
      select: { eventType: true, channel: true, enabled: true },
    });
    return row;
  });
}
