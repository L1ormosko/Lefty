import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listMetricValues, listValuesQuerySchema } from "@/server/performance";

/** GET /api/v1/performance/values: every value snapshot in the caller's scope (history), newest first; `evidenceCount` only. */
export const GET = defineRoute({
  schemas: { query: listValuesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view"),
  handler: async ({ ctx, input }) => respond(200, await listMetricValues(actorOf(ctx), input.query)),
});
