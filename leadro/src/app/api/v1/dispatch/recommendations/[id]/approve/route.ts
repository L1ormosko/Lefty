import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { approveRecommendation, approveRecommendationSchema, recommendationIdParams } from "@/server/dispatch";

/** POST /api/v1/dispatch/recommendations/{id}/approve: assign the top-ranked candidate (hard eligibility re-checked). */
export const POST = defineRoute({
  schemas: { params: recommendationIdParams, body: approveRecommendationSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("dispatch.assign"),
  handler: async ({ ctx, input }) => ok(await approveRecommendation(actorOf(ctx), ctx, input.params.id, input.body)),
});
