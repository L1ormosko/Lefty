import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { assignLead, assignLeadSchema, leadIdParams } from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** POST /api/v1/leads/{id}/assign: assign or reassign the lead (conflict rules of spec 25.1; notifies the new owner). */
export const POST = defineRoute({
  schemas: { params: leadIdParams, body: assignLeadSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.assign", resolveLead),
  handler: async ({ ctx, input }) => ok(await assignLead(actorOf(ctx), ctx, input.params.id, input.body)),
});
