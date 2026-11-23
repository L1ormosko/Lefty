import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { leadDuplicateFlagParams, resolveLeadDuplicateFlag, resolveLeadDuplicateSchema } from "@/server/leads";

/** POST /api/v1/leads/duplicates/{flagId}/resolve: records "not a duplicate" or "confirmed duplicate" (never merges). */
export const POST = defineRoute({
  schemas: { params: leadDuplicateFlagParams, body: resolveLeadDuplicateSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.edit"),
  handler: async ({ ctx, input }) => ok(await resolveLeadDuplicateFlag(actorOf(ctx), ctx, input.params.flagId, input.body)),
});
