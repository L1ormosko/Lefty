import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { upholdDataChallenge, upholdDataChallengeSchema } from "@/server/data-challenges";

/** POST /api/v1/data-challenges/{id}/uphold: the assigned reviewer upholds it with an annotation or a proven correction. */
export const POST = defineRoute({
  schemas: { params: idParams, body: upholdDataChallengeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("data_challenges.approve"),
  handler: async ({ ctx, input }) => ok(await upholdDataChallenge(actorOf(ctx), ctx, input.params.id, input.body)),
});
