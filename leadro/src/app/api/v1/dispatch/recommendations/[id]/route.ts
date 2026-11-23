import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getRecommendation, recommendationIdParams } from "@/server/dispatch";

/** GET /api/v1/dispatch/recommendations/{id}: one recommendation with every factor, conflict and blocking reason. */
export const GET = defineRoute({
  schemas: { params: recommendationIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.view"),
  handler: async ({ ctx, input }) => ok(await getRecommendation(actorOf(ctx), input.params.id)),
});
