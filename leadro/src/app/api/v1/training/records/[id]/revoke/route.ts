import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { revokeRecord, trainingDecisionReasonSchema, trainingIdParams } from "@/server/training";

/** POST /api/v1/training/records/{id}/revoke: VERIFIED -> REVOKED with a reason; the qualification it supported follows. */
export const POST = defineRoute({
  schemas: { params: trainingIdParams, body: trainingDecisionReasonSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.approve"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await revokeRecord(actorOf(ctx), ctx, input.params.id, input.body.reason)),
});
