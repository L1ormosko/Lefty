import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { completePlan, developmentEmptyBodySchema, developmentIdParams } from "@/server/development";

/** POST /api/v1/development-plans/{id}/complete: ACTIVE -> COMPLETED. */
export const POST = defineRoute({
  schemas: { params: developmentIdParams, body: developmentEmptyBodySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => ok(await completePlan(actorOf(ctx), ctx, input.params.id)),
});
