import { authenticateRequest } from "@/server/auth";
import { dashboardIdParams, dashboardQuerySchema, getDashboard } from "@/server/analytics";
import { actorOf, defineRoute, ok } from "@/server/core";

/**
 * GET /api/v1/analytics/dashboards/{id}: one dashboard computed for the caller's scope. 404 unknown id; 403 without the
 * dashboard's family permission (audited). Each KPI is checked on its own: KPIs the caller may not see come back `hidden`.
 * The family check depends on the dashboard, so it lives in the service rather than a route-level `authorize`.
 */
export const GET = defineRoute({
  schemas: { params: dashboardIdParams, query: dashboardQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => ok(await getDashboard(actorOf(ctx), input.params.id, input.query, ctx)),
});
