import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { convertLead, convertLeadSchema, leadIdParams } from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** POST /api/v1/leads/{id}/convert: create the job and mark the lead CONVERTED, in one transaction. */
export const POST = defineRoute({
  schemas: { params: leadIdParams, body: convertLeadSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.view", resolveLead),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await convertLead(actorOf(ctx), ctx, input.params.id, input.body)),
});
