import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { developmentGoalParams, updateGoal, updateGoalSchema } from "@/server/development";

/** PATCH /api/v1/development-plans/{id}/goals/{goalId}: changes a goal; returns the plan. */
export const PATCH = defineRoute({
  schemas: { params: developmentGoalParams, body: updateGoalSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => ok(await updateGoal(actorOf(ctx), ctx, input.params.id, input.params.goalId, input.body)),
});
