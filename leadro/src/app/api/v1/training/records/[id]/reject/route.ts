import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { rejectRecord, trainingDecisionReasonSchema, trainingIdParams } from "@/server/training";

/** POST /api/v1/training/records/{id}/reject: PENDING_VERIFICATION -> REJECTED with a reason (`training.approve`). */
export const POST = defineRoute({
  schemas: { params: trainingIdParams, body: trainingDecisionReasonSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.approve"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await rejectRecord(actorOf(ctx), ctx, input.params.id, input.body.reason)),
});
