import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listDuplicateFlags, listDuplicatesQuerySchema } from "@/server/customers";

/** GET /api/v1/customers/duplicates: the duplicate review queue (flags whose two customers the caller may view), newest first. */
export const GET = defineRoute({
  schemas: { query: listDuplicatesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.view"),
  handler: async ({ ctx, input }) => respond(200, await listDuplicateFlags(actorOf(ctx), input.query)),
});
