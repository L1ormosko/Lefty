import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { countOwnUnread } from "@/server/notifications";

/** GET /api/v1/notifications/unread-count: the caller's unread count (the bell badge). */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("notifications.view"),
  handler: async ({ ctx }) => ok(await countOwnUnread(actorOf(ctx))),
});
