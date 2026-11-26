import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { rejectDataChallenge, rejectDataChallengeSchema } from "@/server/data-challenges";

/** POST /api/v1/data-challenges/{id}/reject: the assigned reviewer rejects it with a reason shown to the employee. */
export const POST = defineRoute({
  schemas: { params: idParams, body: rejectDataChallengeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("data_challenges.reject"),
  handler: async ({ ctx, input }) => ok(await rejectDataChallenge(actorOf(ctx), ctx, input.params.id, input.body)),
});
