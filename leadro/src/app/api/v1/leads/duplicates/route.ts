import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listLeadDuplicateFlags, listLeadDuplicatesQuerySchema } from "@/server/leads";

/** GET /api/v1/leads/duplicates: the lead duplicate review queue (lead-lead and lead-customer pairs). */
export const GET = defineRoute({
  schemas: { query: listLeadDuplicatesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.view"),
  handler: async ({ ctx, input }) => respond(200, await listLeadDuplicateFlags(actorOf(ctx), input.query)),
});
