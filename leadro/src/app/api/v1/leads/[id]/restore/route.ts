import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveLeadSchema, leadIdParams, restoreLead } from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** POST /api/v1/leads/{id}/restore: bring an archived lead back (its owner assignment stays ended). */
export const POST = defineRoute({
  schemas: { params: leadIdParams, body: archiveLeadSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.archive", resolveLead),
  handler: async ({ ctx, input }) => ok(await restoreLead(actorOf(ctx), ctx, input.params.id, input.body)),
});
