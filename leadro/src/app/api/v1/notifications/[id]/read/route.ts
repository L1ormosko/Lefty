import "@/server/notification-targets"; // registers the lead/job resolvers the redaction check needs
import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { markOwnNotificationRead } from "@/server/notifications";

/** POST /api/v1/notifications/{id}/read: marks one of the caller's notifications read (idempotent; 404 for anyone else's). */
export const POST = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("notifications.edit"),
  handler: async ({ ctx, input }) => ok(await markOwnNotificationRead(actorOf(ctx), input.params.id)),
});
