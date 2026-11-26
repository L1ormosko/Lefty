import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { developmentIdParams, getPlan, updatePlan, updatePlanSchema } from "@/server/development";

/** GET /api/v1/development-plans/{id}: the plan with goals, actions and reviews. */
export const GET = defineRoute({
  schemas: { params: developmentIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.view"),
  handler: async ({ ctx, input }) => ok(await getPlan(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/development-plans/{id}: title, summary, period, owner (DRAFT / ACTIVE). */
export const PATCH = defineRoute({
  schemas: { params: developmentIdParams, body: updatePlanSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => ok(await updatePlan(actorOf(ctx), ctx, input.params.id, input.body)),
});
