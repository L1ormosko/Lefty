import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { acceptRecommendation, acceptRecommendationSchema, developmentIdParams } from "@/server/development";

/** POST /api/v1/training/recommendations/{id}/accept: OPEN -> ACCEPTED plus a training assignment (source RECOMMENDATION). */
export const POST = defineRoute({
  schemas: { params: developmentIdParams, body: acceptRecommendationSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.assign"),
  handler: async ({ ctx, input }) => ok(await acceptRecommendation(actorOf(ctx), ctx, input.params.id, input.body)),
});
