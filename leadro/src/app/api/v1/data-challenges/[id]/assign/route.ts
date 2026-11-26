import "@/server/notification-targets"; // registers the resolvers the notification redaction check needs
import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { assignDataChallengeReviewer, assignDataChallengeSchema } from "@/server/data-challenges";

/** POST /api/v1/data-challenges/{id}/assign: routes the challenge to a reviewer who can decide it (notifies the reviewer). */
export const POST = defineRoute({
  schemas: { params: idParams, body: assignDataChallengeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("data_challenges.assign"),
  handler: async ({ ctx, input }) => ok(await assignDataChallengeReviewer(actorOf(ctx), ctx, input.params.id, input.body)),
});
