import { authenticateRequest } from "@/server/auth";
import { computeKpi, kpiKeyParams, kpiQuerySchema } from "@/server/analytics";
import { actorOf, defineRoute, ok } from "@/server/core";

/**
 * GET /api/v1/analytics/kpis/{key}: values of one KPI for the caller's scope, grouped by period (tenant time zone) and org level,
 * with sample counts and drill-down record ids. 404 unknown key; 403 without the KPI's own permission and field set (audited).
 * The permission check is the engine's (it depends on the KPI), so there is no route-level `authorize`.
 */
export const GET = defineRoute({
  schemas: { params: kpiKeyParams, query: kpiQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => ok(await computeKpi(actorOf(ctx), input.params.key, input.query, ctx)),
});
