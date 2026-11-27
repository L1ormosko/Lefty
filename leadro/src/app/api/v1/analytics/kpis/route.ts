import { authenticateRequest } from "@/server/auth";
import { listVisibleKpis } from "@/server/analytics";
import { actorOf, defineRoute, ok } from "@/server/core";

/**
 * GET /api/v1/analytics/kpis: the KPI catalog entries (spec 13.4 metadata) whose own permission and field set the caller holds
 * over some scope; entries the caller may not see are left out (an empty list for a role without analytics).
 */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  handler: async ({ ctx }) => ok(await listVisibleKpis(actorOf(ctx))),
});
