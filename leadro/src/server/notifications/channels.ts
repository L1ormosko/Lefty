import type { NotificationChannel as ChannelKind } from "@prisma/client";
import type { NotificationParams } from "@/lib/notification-rules";

/** What a channel gets to send. Ids and keys only: a provider renders text with `renderNotificationForRecipient`. */
export interface ChannelMessage {
  tenantId: string;
  notificationId: string;
  recipientId: string;
  channel: ChannelKind;
  /** 1 for the first try; the retry worker increments it. */
  attempt: number;
  eventType: string;
  templateKey: string;
  params: NotificationParams;
  targetType: string | null;
  targetId: string | null;
}

/**
 * How one attempt ended. Truthfulness rule (§28.3): only report DELIVERED/SENT when a provider
 * actually accepted the message; a channel with no provider reports NOT_CONFIGURED.
 */
export type ChannelResult =
  | { outcome: "DELIVERED"; provider: string; providerResponse?: Record<string, unknown> }
  | { outcome: "SENT"; provider: string; providerResponse?: Record<string, unknown> }
  | { outcome: "NOT_CONFIGURED" }
  | { outcome: "FAILED"; provider: string; reason: string; retryable: boolean; providerResponse?: Record<string, unknown> };

/** A delivery route (in-app, push, email, SMS). Providers implement it and register with `setNotificationChannel`. */
export interface NotificationChannel {
  readonly channel: ChannelKind;
  send(message: ChannelMessage): Promise<ChannelResult>;
}

/**
 * The in-app channel: the notification row IS the inbox entry, so once it is stored the message is
 * available to the recipient and "delivery" only records that fact.
 */
export const inAppChannel: NotificationChannel = {
  channel: "IN_APP",
  async send() {
    return { outcome: "DELIVERED", provider: "in_app" };
  },
};

/** Default for PUSH / EMAIL / SMS until a provider is installed: records NOT_CONFIGURED, sends nothing. */
export function notConfiguredChannel(channel: ChannelKind): NotificationChannel {
  return {
    channel,
    async send() {
      return { outcome: "NOT_CONFIGURED" };
    },
  };
}

const defaultChannels = (): Map<ChannelKind, NotificationChannel> =>
  new Map<ChannelKind, NotificationChannel>([
    ["IN_APP", inAppChannel],
    ["PUSH", notConfiguredChannel("PUSH")],
    ["EMAIL", notConfiguredChannel("EMAIL")],
    ["SMS", notConfiguredChannel("SMS")],
  ]);

let registry = defaultChannels();

/** The implementation currently installed for `channel` (never undefined: every channel has a default). */
export function getNotificationChannel(channel: ChannelKind): NotificationChannel {
  const found = registry.get(channel);
  if (!found) throw new Error(`No notification channel registered for ${channel}`); // unreachable: all four have defaults
  return found;
}

/** Installs a provider (a real email sender, ...). Replaces the default for `implementation.channel`. */
export function setNotificationChannel(implementation: NotificationChannel): void {
  registry.set(implementation.channel, implementation);
}

/** Restores the four defaults (tests, shutdown). */
export function resetNotificationChannels(): void {
  registry = defaultChannels();
}
