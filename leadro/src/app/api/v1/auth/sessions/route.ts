import { authenticateRequest, listOwnSessions } from "@/server/auth";
import { defineRoute, ok } from "@/server/core";

/** GET /api/v1/auth/sessions: the caller's own live sessions (own data, no permission needed). */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  handler: async ({ ctx }) => ok(await listOwnSessions(ctx.actor!)),
});
