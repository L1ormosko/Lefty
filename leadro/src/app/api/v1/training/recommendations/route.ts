import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listRecommendations, listRecommendationsQuerySchema } from "@/server/development";

/** GET /api/v1/training/recommendations: recommendations in the caller's `training.view` scope, newest first. */
export const GET = defineRoute({
  schemas: { query: listRecommendationsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => respond(200, await listRecommendations(actorOf(ctx), input.query)),
});
