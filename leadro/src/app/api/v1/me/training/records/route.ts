import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listOwnRecords, ownRecordsQuerySchema } from "@/server/training";

/** GET /api/v1/me/training/records: self-service. The caller's training completions in every status, with expiry. */
export const GET = defineRoute({
  schemas: { query: ownRecordsQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => respond(200, await listOwnRecords(actorOf(ctx), input.query)),
});
