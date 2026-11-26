import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { generateRecommendations, generateRecommendationsSchema } from "@/server/development";

/** POST /api/v1/training/recommendations/generate: runs the rules for one employee or every active employee in scope. */
export const POST = defineRoute({
  schemas: { body: generateRecommendationsSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.assign"),
  handler: async ({ ctx, input }) => ok(await generateRecommendations(actorOf(ctx), ctx, input.body)),
});
