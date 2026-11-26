import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getAssignment, trainingIdParams, updateAssignment, updateAssignmentSchema } from "@/server/training";

/** GET /api/v1/training/assignments/{id}. */
export const GET = defineRoute({
  schemas: { params: trainingIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => ok(await getAssignment(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/training/assignments/{id}: due date and note of an open assignment (`training.edit`). */
export const PATCH = defineRoute({
  schemas: { params: trainingIdParams, body: updateAssignmentSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.edit"),
  handler: async ({ ctx, input }) => ok(await updateAssignment(actorOf(ctx), ctx, input.params.id, input.body)),
});
