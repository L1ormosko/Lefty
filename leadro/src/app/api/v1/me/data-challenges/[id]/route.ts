import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getOwnDataChallenge } from "@/server/data-challenges";

/** GET /api/v1/me/data-challenges/{id}: self-service. One of the caller's challenges with its status and resolution (else 404). */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => ok(await getOwnDataChallenge(actorOf(ctx), input.params.id)),
});
