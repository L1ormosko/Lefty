import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { leadSourceParams, updateLeadSource, updateLeadSourceSchema } from "@/server/leads";

/** PATCH /api/v1/leads/sources/{sourceId}: rename or switch a source on/off (`leads.manage`, tenant-wide). */
export const PATCH = defineRoute({
  schemas: { params: leadSourceParams, body: updateLeadSourceSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("leads.manage"),
  handler: async ({ ctx, input }) => ok(await updateLeadSource(actorOf(ctx), ctx, input.params.sourceId, input.body)),
});
