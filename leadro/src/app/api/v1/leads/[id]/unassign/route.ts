import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { leadIdParams, unassignLead, unassignLeadSchema } from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** POST /api/v1/leads/{id}/unassign: release the owner; the lead returns to UNASSIGNED. */
export const POST = defineRoute({
  schemas: { params: leadIdParams, body: unassignLeadSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.assign", resolveLead),
  handler: async ({ ctx, input }) => ok(await unassignLead(actorOf(ctx), ctx, input.params.id, input.body)),
});
