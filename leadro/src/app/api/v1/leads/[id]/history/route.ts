import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { leadIdParams, listLeadStatusHistory } from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** GET /api/v1/leads/{id}/history: every status change, oldest first. */
export const GET = defineRoute({
  schemas: { params: leadIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.view", resolveLead),
  handler: async ({ ctx, input }) => ok(await listLeadStatusHistory(actorOf(ctx), input.params.id)),
});
