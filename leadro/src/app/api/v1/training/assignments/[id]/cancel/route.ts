import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { cancelAssignment, cancelAssignmentSchema, trainingIdParams } from "@/server/training";

/** POST /api/v1/training/assignments/{id}/cancel: an open assignment -> CANCELLED with a reason (`training.edit`). */
export const POST = defineRoute({
  schemas: { params: trainingIdParams, body: cancelAssignmentSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.edit"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await cancelAssignment(actorOf(ctx), ctx, input.params.id, input.body)),
});
