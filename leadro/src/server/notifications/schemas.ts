import { z } from "zod";
import { ALL_EVENTS } from "@/lib/notification-rules";
import { pageQuerySchema } from "@/server/core";
import { NOTIFICATION_EVENTS } from "./events";

/** `?unread=true` lists only unread notifications. Query strings are text, so parse it explicitly. */
export const listNotificationsQuerySchema = pageQuerySchema.extend({
  unread: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
});
export type ListNotificationsQuery = z.output<typeof listNotificationsQuerySchema>;

const eventTypes = Object.keys(NOTIFICATION_EVENTS) as [string, ...string[]];

/**
 * One preference: `eventType` is a known event or "*" (every non-critical event). IN_APP is not
 * accepted: the inbox is the record of the event and cannot be switched off.
 */
export const setPreferenceSchema = z
  .object({
    eventType: z.enum([ALL_EVENTS, ...eventTypes]),
    channel: z.enum(["PUSH", "EMAIL", "SMS"]),
    enabled: z.boolean(),
  })
  .strict();
export type SetPreferenceInput = z.output<typeof setPreferenceSchema>;
