import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listOwnDataChallenges, ownDataChallengesQuerySchema } from "@/server/data-challenges";

/** GET /api/v1/me/data-challenges: self-service. The challenges the caller raised about their own data, newest first. */
export const GET = defineRoute({
  schemas: { query: ownDataChallengesQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => respond(200, await listOwnDataChallenges(actorOf(ctx), input.query)),
});
