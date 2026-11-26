import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { developmentActionParams, updateAction, updateActionSchema } from "@/server/development";

/** PATCH /api/v1/development-plans/{id}/actions/{actionId}: changes a PLANNED action or records its outcome; returns the plan. */
export const PATCH = defineRoute({
  schemas: { params: developmentActionParams, body: updateActionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.edit"),
  handler: async ({ ctx, input }) => ok(await updateAction(actorOf(ctx), ctx, input.params.id, input.params.actionId, input.body)),
});
