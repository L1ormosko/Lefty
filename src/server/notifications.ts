import "server-only";
import type { NotificationType } from "@prisma/client";
import { prisma } from "./db";

/** In-app notification. Email delivery can be added behind the same call. */
export async function notify(params: {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  linkUrl?: string;
}): Promise<void> {
  try {
    await prisma.notification.create({ data: params });
  } catch (err) {
    // A failed notification must never fail the business operation.
    console.error("[velto] notification failed:", err);
  }
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}
