import { authenticateRequest } from "@/server/auth";
import { listOwnSharedContextNotes, ownContextNotesQuerySchema } from "@/server/coaching";
import { actorOf, defineRoute, respond } from "@/server/core";

/** GET /api/v1/me/context-notes: self-service. Managers' context notes on the caller's metrics that were shared with them. */
export const GET = defineRoute({
  schemas: { query: ownContextNotesQuerySchema },
  authenticate: authenticateRequest,
  handler: async ({ ctx, input }) => respond(200, await listOwnSharedContextNotes(actorOf(ctx), input.query)),
});
