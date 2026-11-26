import { authenticateRequest } from "@/server/auth";
import { listOwnSharedCoachingRecords, ownCoachingRecordsQuerySchema } from "@/server/coaching";
import { actorOf, defineRoute, respond } from "@/server/core";

/** GET /api/v1/me/coaching-notes: self-service. Coaching notes about the caller that were shared with them (not archived). */
export const GET = defineRoute({
  schemas: { query: ownCoachingRecordsQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => respond(200, await listOwnSharedCoachingRecords(actorOf(ctx), input.query)),
});
