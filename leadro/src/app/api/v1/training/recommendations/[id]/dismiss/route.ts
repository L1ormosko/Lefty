import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { developmentIdParams, dismissRecommendation, dismissRecommendationSchema } from "@/server/development";

/** POST /api/v1/training/recommendations/{id}/dismiss: OPEN -> DISMISSED with a reason. */
export const POST = defineRoute({
  schemas: { params: developmentIdParams, body: dismissRecommendationSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.assign"),
  handler: async ({ ctx, input }) => ok(await dismissRecommendation(actorOf(ctx), ctx, input.params.id, input.body)),
});
