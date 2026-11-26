import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { trainingIdParams, verifyRecord, verifyRecordSchema } from "@/server/training";

/** POST /api/v1/training/records/{id}/verify: HR verifies; completes the open assignment and grants / renews the TRAINING qualification. */
export const POST = defineRoute({
  schemas: { params: trainingIdParams, body: verifyRecordSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.approve"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await verifyRecord(actorOf(ctx), ctx, input.params.id)),
});
