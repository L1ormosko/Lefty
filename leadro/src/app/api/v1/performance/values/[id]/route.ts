import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getMetricValue, valueIdParams } from "@/server/performance";

/** GET /api/v1/performance/values/{id}: one value with its evidence ids (404 when missing, outside scope or not visible). */
export const GET = defineRoute({
  schemas: { params: valueIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view"),
  handler: async ({ ctx, input }) => ok(await getMetricValue(actorOf(ctx), input.params.id)),
});
