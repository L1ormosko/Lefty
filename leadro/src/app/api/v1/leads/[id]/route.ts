import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getLead, leadIdParams, updateLead, updateLeadSchema } from "@/server/leads";
import { resolveLead } from "../_lib/resolve-lead";

/** GET /api/v1/leads/{id}: the lead with its current owner and the statuses it can move to (`nextStatuses`). */
export const GET = defineRoute({
  schemas: { params: leadIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.view", resolveLead),
  handler: async ({ ctx, input }) => ok(await getLead(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/leads/{id}: partial update of the lead's content (status, owner, source and customer have their own actions). */
export const PATCH = defineRoute({
  schemas: { params: leadIdParams, body: updateLeadSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.edit", resolveLead),
  handler: async ({ ctx, input }) => ok(await updateLead(actorOf(ctx), ctx, input.params.id, input.body)),
});
