import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { markAllOwnRead } from "@/server/notifications";

/** POST /api/v1/notifications/read-all: marks every unread notification of the caller read. */
export const POST = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("notifications.edit"),
  handler: async ({ ctx }) => ok(await markAllOwnRead(actorOf(ctx))),
});
