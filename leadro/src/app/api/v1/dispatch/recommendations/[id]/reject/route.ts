import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { recommendationIdParams, rejectRecommendation, rejectRecommendationSchema } from "@/server/dispatch";

/** POST /api/v1/dispatch/recommendations/{id}/reject: decline the recommendation with a reason; the job stays pending. */
export const POST = defineRoute({
  schemas: { params: recommendationIdParams, body: rejectRecommendationSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.assign"),
  handler: async ({ ctx, input }) => ok(await rejectRecommendation(actorOf(ctx), ctx, input.params.id, input.body)),
});
