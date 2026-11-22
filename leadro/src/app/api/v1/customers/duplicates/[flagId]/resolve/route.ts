import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { duplicateFlagParams, resolveDuplicateFlag, resolveDuplicateSchema } from "@/server/customers";

/** POST /api/v1/customers/duplicates/{flagId}/resolve: records "not a duplicate" or "confirmed duplicate" (never merges). */
export const POST = defineRoute({
  schemas: { params: duplicateFlagParams, body: resolveDuplicateSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("customers.edit"),
  handler: async ({ ctx, input }) => ok(await resolveDuplicateFlag(actorOf(ctx), ctx, input.params.flagId, input.body)),
});
