import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { changeLeadStatus, changeLeadStatusSchema, leadIdParams } from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** POST /api/v1/leads/{id}/status: a validated status change (ASSIGNED and CONVERTED have their own actions). */
export const POST = defineRoute({
  schemas: { params: leadIdParams, body: changeLeadStatusSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.edit", resolveLead),
  handler: async ({ ctx, input }) => ok(await changeLeadStatus(actorOf(ctx), ctx, input.params.id, input.body)),
});
