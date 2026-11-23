import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveLead, archiveLeadSchema, leadIdParams } from "@/server/leads";
import { resolveLead } from "../../_lib/resolve-lead";

/** POST /api/v1/leads/{id}/archive: soft remove (the body is optional: `{ reason? }`). */
export const POST = defineRoute({
  schemas: { params: leadIdParams, body: archiveLeadSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.archive", resolveLead),
  handler: async ({ ctx, input }) => ok(await archiveLead(actorOf(ctx), ctx, input.params.id, input.body)),
});
