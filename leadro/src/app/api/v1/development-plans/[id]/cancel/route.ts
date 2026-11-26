import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { cancelPlan, cancelPlanSchema, developmentIdParams } from "@/server/development";

/** POST /api/v1/development-plans/{id}/cancel: DRAFT / ACTIVE -> CANCELLED with a reason. */
export const POST = defineRoute({
  schemas: { params: developmentIdParams, body: cancelPlanSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => ok(await cancelPlan(actorOf(ctx), ctx, input.params.id, input.body)),
});
