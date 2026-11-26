import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { activatePlan, developmentEmptyBodySchema, developmentIdParams } from "@/server/development";

/** POST /api/v1/development-plans/{id}/activate: DRAFT -> ACTIVE (the employee is notified). */
export const POST = defineRoute({
  schemas: { params: developmentIdParams, body: developmentEmptyBodySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => ok(await activatePlan(actorOf(ctx), ctx, input.params.id)),
});
