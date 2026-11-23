import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { closeInteraction, closeInteractionSchema, leadInteractionParams } from "@/server/leads";
import { resolveLead } from "../../../../_lib/resolve-lead";

/** POST /api/v1/leads/{id}/interactions/{interactionId}/close: finish an open contact attempt with its outcome. */
export const POST = defineRoute({
  schemas: { params: leadInteractionParams, body: closeInteractionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("leads.edit", resolveLead),
  handler: async ({ ctx, input }) =>
    ok(await closeInteraction(actorOf(ctx), ctx, input.params.id, input.params.interactionId, input.body)),
});
