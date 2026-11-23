import "@/server/notification-targets"; // registers the lead/job resolvers the redaction check needs
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listNotificationsQuerySchema, listOwnNotifications } from "@/server/notifications";

/** GET /api/v1/notifications: the caller's own notifications, newest first. Never another user's. */
export const GET = defineRoute({
  schemas: { query: listNotificationsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("notifications.view"),
  handler: async ({ ctx, input }) => respond(200, await listOwnNotifications(actorOf(ctx), input.query)),
});
