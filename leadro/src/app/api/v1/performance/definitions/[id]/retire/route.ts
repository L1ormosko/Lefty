import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { definitionIdParams, reasonSchema, retireDefinition } from "@/server/performance";

/** POST /api/v1/performance/definitions/{id}/retire: PUBLISHED or DRAFT -> RETIRED, with a reason. `performance.configure`. */
export const POST = defineRoute({
  schemas: { params: definitionIdParams, body: reasonSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("performance.configure"),
  handler: async ({ ctx, input }) => ok(await retireDefinition(actorOf(ctx), ctx, input.params.id, input.body)),
});
