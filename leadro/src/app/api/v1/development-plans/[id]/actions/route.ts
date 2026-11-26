import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { addAction, createActionSchema, developmentIdParams } from "@/server/development";

/** POST /api/v1/development-plans/{id}/actions: adds an action; returns the plan. */
export const POST = defineRoute({
  schemas: { params: developmentIdParams, body: createActionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => created(await addAction(actorOf(ctx), ctx, input.params.id, input.body)),
});
