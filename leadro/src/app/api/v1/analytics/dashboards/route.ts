import { authenticateRequest } from "@/server/auth";
import { listDashboards } from "@/server/analytics";
import { actorOf, defineRoute, ok } from "@/server/core";

/**
 * GET /api/v1/analytics/dashboards: the dashboard definitions (sections of KPI keys with default grouping and period) whose
 * family permission the caller holds; others are left out (an empty list for a role without analytics).
 */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  handler: async ({ ctx }) => ok(await listDashboards(actorOf(ctx))),
});
