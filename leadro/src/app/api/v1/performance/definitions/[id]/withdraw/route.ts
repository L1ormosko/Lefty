import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { definitionIdParams, reasonSchema, withdrawDefinition } from "@/server/performance";

/** POST /api/v1/performance/definitions/{id}/withdraw: PENDING_APPROVAL -> DRAFT, cancelling the approval request. */
export const POST = defineRoute({
  schemas: { params: definitionIdParams, body: reasonSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("performance.configure"),
  handler: async ({ ctx, input }) => ok(await withdrawDefinition(actorOf(ctx), ctx, input.params.id, input.body)),
});
