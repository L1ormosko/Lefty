import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { developmentIdParams, getRecommendation } from "@/server/development";

/** GET /api/v1/training/recommendations/{id}. */
export const GET = defineRoute({
  schemas: { params: developmentIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => ok(await getRecommendation(actorOf(ctx), input.params.id)),
});
