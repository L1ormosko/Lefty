import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { startAssignment, startAssignmentSchema, trainingIdParams } from "@/server/training";

/** POST /api/v1/training/assignments/{id}/start: ASSIGNED -> IN_PROGRESS (`training.edit`). */
export const POST = defineRoute({
  schemas: { params: trainingIdParams, body: startAssignmentSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.edit"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await startAssignment(actorOf(ctx), ctx, input.params.id)),
});
