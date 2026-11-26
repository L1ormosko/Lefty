import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, ok } from "@/server/core";
import { employeeValuesQuerySchema, listOwnCurrentValues } from "@/server/performance";

/**
 * GET /api/v1/me/metrics: self-service. The caller's CURRENT value per published definition version, period and breakdown
 * (no module permission; own rows only, never a preview). Each entry stands alone: no total, average or rank.
 */
export const GET = defineRoute({
  schemas: { query: employeeValuesQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => ok(await listOwnCurrentValues(actorOf(ctx), input.query)),
});
