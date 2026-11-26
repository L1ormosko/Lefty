import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, ok } from "@/server/core";
import { withdrawDataChallenge } from "@/server/data-challenges";

/** POST /api/v1/data-challenges/{id}/withdraw: self-service; only the person who raised the challenge (else 404). */
export const POST = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => ok(await withdrawDataChallenge(actorOf(ctx), ctx, input.params.id)),
});
