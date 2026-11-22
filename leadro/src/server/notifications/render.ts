import type { TranslateFn } from "@/lib/i18n";
import type { NotificationParams } from "@/lib/notification-rules";
import { getTranslatorForRequest } from "@/server/i18n";

/** The part of a notification row that decides its text. */
export interface RenderableNotification {
  templateKey: string;
  params: unknown;
}

export interface RenderedNotification {
  title: string;
  body: string;
}

/**
 * Text is produced at READ time from the template key and the stored ids/numbers (§16, ERD "ids
 * only"): rows never contain translated text, so a changed locale or a reviewed tenant override
 * applies to old notifications too. `t` must be the RECIPIENT's translator.
 */
export function renderNotification(t: TranslateFn, notification: RenderableNotification): RenderedNotification {
  const params = interpolationParams(notification.params);
  return { title: t(`${notification.templateKey}.TITLE`, params), body: t(`${notification.templateKey}.BODY`, params) };
}

/**
 * Renders for a user in THEIR locale chain (user, branch, company, en-US) with the tenant's reviewed
 * overrides. This is what an email/SMS/push provider calls, because the sender is not the recipient.
 */
export async function renderNotificationForRecipient(
  tenantId: string,
  recipientUserId: string,
  notification: RenderableNotification,
): Promise<RenderedNotification> {
  const { t } = await getTranslatorForRequest(tenantId, { userId: recipientUserId });
  return renderNotification(t, notification);
}

/** Stored params are JSON; keep only the primitives the translator can interpolate. */
function interpolationParams(raw: unknown): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw as NotificationParams)) {
      if (typeof value === "string" || typeof value === "number") result[name] = value;
      else if (typeof value === "boolean") result[name] = String(value);
    }
  }
  return result;
}
