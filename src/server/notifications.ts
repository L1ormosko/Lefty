import "server-only";
import type { NotificationType } from "@prisma/client";
import { prisma } from "./db";
import { sendEmail } from "./email";

/**
 * In-app notification, mirrored to email when a provider is configured (see
 * server/email.ts). This is the single call site for every notification -
 * add a new event type here, not a second ad-hoc send path.
 */
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

  try {
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { email: true },
    });
    if (!user) return;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
    const link = params.linkUrl ? `\n\n${appUrl}${params.linkUrl}` : "";
    await sendEmail({
      to: user.email,
      subject: params.title,
      text: `${params.body ?? params.title}${link}`,
    });
  } catch (err) {
    console.error("[velto] notification email failed:", err);
  }
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}
