import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getRecord, trainingIdParams } from "@/server/training";

/** GET /api/v1/training/records/{id}. */
export const GET = defineRoute({
  schemas: { params: trainingIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => ok(await getRecord(actorOf(ctx), input.params.id)),
});
