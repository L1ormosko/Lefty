import { authenticateRequest } from "@/server/auth";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listOwnQualifications, ownQualificationsQuerySchema } from "@/server/qualifications";

/** GET /api/v1/me/qualifications: self-service certification status. The caller's skills and credentials in every status. */
export const GET = defineRoute({
  schemas: { query: ownQualificationsQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => respond(200, await listOwnQualifications(actorOf(ctx), input.query)),
});
