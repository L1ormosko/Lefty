import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listUsers, listUsersQuerySchema } from "@/server/users";

/** GET /api/v1/users: paginated, scope-filtered (via the user's employee), field-projected. */
export const GET = defineRoute({
  schemas: { query: listUsersQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("users.view"),
  handler: async ({ ctx, input }) => respond(200, await listUsers(actorOf(ctx), input.query)),
});
