import { z } from "zod";
import { authenticateRequest, clientInfoFromRequest, revokeOwnSession } from "@/server/auth";
import { defineRoute, noContent } from "@/server/core";

/** DELETE /api/v1/auth/sessions/{sessionId}: revokes one of the caller's own sessions. */
export const DELETE = defineRoute({
  schemas: { params: z.object({ sessionId: z.string().min(1).max(64) }) },
  authenticate: authenticateRequest,
  handler: async ({ req, ctx, input }) => {
    await revokeOwnSession(ctx.actor!, input.params.sessionId, clientInfoFromRequest(req, ctx));
    return noContent();
  },
});
