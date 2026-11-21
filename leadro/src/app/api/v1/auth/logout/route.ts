import { defineRoute, noContent } from "@/server/core";
import {
  authenticateMfaRequest,
  clientInfoFromRequest,
  logout,
  queueClearSessionCookie,
  withSessionCookie,
} from "@/server/auth";

/** POST /api/v1/auth/logout: revokes the current session (also while MFA is still pending). */
export const POST = withSessionCookie(
  defineRoute({
    authenticate: authenticateMfaRequest,
    handler: async ({ req, ctx }) => {
      // ctx.actor is guaranteed non-null by the `authenticate` hook.
      await logout(ctx.actor!, clientInfoFromRequest(req, ctx));
      queueClearSessionCookie(req);
      return noContent();
    },
  }),
);
