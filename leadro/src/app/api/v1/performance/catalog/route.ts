import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getMetricCatalog } from "@/server/performance";

/** GET /api/v1/performance/catalog: the fixed metric kind catalog (dimension, evidence table, params, breakdowns). */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view"),
  handler: async ({ ctx }) => ok(await getMetricCatalog(actorOf(ctx))),
});
