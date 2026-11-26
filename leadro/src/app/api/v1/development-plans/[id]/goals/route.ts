import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { addGoal, createGoalSchema, developmentIdParams } from "@/server/development";

/** POST /api/v1/development-plans/{id}/goals: adds a goal; returns the plan. */
export const POST = defineRoute({
  schemas: { params: developmentIdParams, body: createGoalSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => created(await addGoal(actorOf(ctx), ctx, input.params.id, input.body)),
});
