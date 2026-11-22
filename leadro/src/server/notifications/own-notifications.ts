import type { Prisma } from "@prisma/client";
import { pageArgs, toPage, NotFoundError, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { enforceInTx } from "@/server/authz";
import type { NotificationParams } from "@/lib/notification-rules";
import type { ListNotificationsQuery } from "./schemas";

/**
 * What a client gets for one notification. No display text (docs/API_CONVENTIONS.md): the UI renders
 * `templateKey` + `params` in the user's language (`renderNotification`). `targetType`/`targetId`
 * are a deep link only; opening the target re-checks the viewer's access there.
 */
export interface NotificationView {
  id: string;
  eventType: string;
  templateKey: string;
  params: NotificationParams;
  targetType: string | null;
  targetId: string | null;
  critical: boolean;
  readAt: Date | null;
  createdAt: Date;
}

const VIEW_SELECT = {
  id: true,
  eventType: true,
  templateKey: true,
  params: true,
  targetType: true,
  targetId: true,
  critical: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

const toView = (row: Prisma.NotificationGetPayload<{ select: typeof VIEW_SELECT }>): NotificationView => ({
  ...row,
  params: (row.params ?? {}) as NotificationParams,
});

/*
 * Own-notification API. `notifications.view` / `notifications.edit` are CAPABILITY checks: whatever
 * scope the assignment carries, every query is pinned to `recipientId = actor.userId`, so nobody
 * can read or change another user's inbox. Another user's notification id is a 404, never a 403
 * (existence is not confirmed). Marking read is a per-user convenience, not a business change, so
 * it is not audited.
 */

/** The caller's notifications, newest first (`createdAt desc, id desc`). */
export async function listOwnNotifications(actor: Actor, query: ListNotificationsQuery): Promise<Page<NotificationView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "notifications.view");
    const rows = await tx.notification.findMany({
      where: { tenantId: actor.tenantId, recipientId: actor.userId, ...(query.unread ? { readAt: null } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: VIEW_SELECT,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toView), page: page.page };
  });
}

/** How many of the caller's notifications are unread (the bell badge). */
export async function countOwnUnread(actor: Actor): Promise<{ unread: number }> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "notifications.view");
    return { unread: await tx.notification.count({ where: { tenantId: actor.tenantId, recipientId: actor.userId, readAt: null } }) };
  });
}

/** Marks one of the caller's notifications read. Idempotent: an already-read one keeps its original `readAt`. */
export async function markOwnNotificationRead(actor: Actor, notificationId: string): Promise<{ id: string; readAt: Date }> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "notifications.edit");
    const where = { id: notificationId, tenantId: actor.tenantId, recipientId: actor.userId };
    await tx.notification.updateMany({ where: { ...where, readAt: null }, data: { readAt: new Date() } });
    const row = await tx.notification.findFirst({ where, select: { id: true, readAt: true } });
    if (!row?.readAt) throw new NotFoundError();
    return { id: row.id, readAt: row.readAt };
  });
}

/** Marks every unread notification of the caller read; returns how many changed. */
export async function markAllOwnRead(actor: Actor): Promise<{ updated: number }> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "notifications.edit");
    const result = await tx.notification.updateMany({
      where: { tenantId: actor.tenantId, recipientId: actor.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  });
}
