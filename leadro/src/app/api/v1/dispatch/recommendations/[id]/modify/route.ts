import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { modifyRecommendation, modifyRecommendationSchema, recommendationIdParams } from "@/server/dispatch";

/** POST /api/v1/dispatch/recommendations/{id}/modify: assign someone else, with a reason (and an override if they are ineligible). */
export const POST = defineRoute({
  schemas: { params: recommendationIdParams, body: modifyRecommendationSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.assign"),
  handler: async ({ ctx, input }) => ok(await modifyRecommendation(actorOf(ctx), ctx, input.params.id, input.body)),
});
