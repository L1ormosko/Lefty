import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { addReview, createReviewSchema, developmentIdParams } from "@/server/development";

/** POST /api/v1/development-plans/{id}/reviews: appends a review entry; returns the plan. */
export const POST = defineRoute({
  schemas: { params: developmentIdParams, body: createReviewSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => created(await addReview(actorOf(ctx), ctx, input.params.id, input.body)),
});
