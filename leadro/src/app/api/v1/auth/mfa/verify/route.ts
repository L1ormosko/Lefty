import { z } from "zod";
import { defineRoute, noContent } from "@/server/core";
import {
  authenticateMfaRequest,
  clientInfoFromRequest,
  queueSessionCookie,
  verifyMfaChallenge,
  withSessionCookie,
} from "@/server/auth";

/** POST /api/v1/auth/mfa/verify: login step 2. Promotes an MFA-pending session and rotates its cookie. */
export const POST = withSessionCookie(
  defineRoute({
    schemas: { body: z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }) },
    authenticate: authenticateMfaRequest,
    handler: async ({ req, ctx, input }) => {
      const promoted = await verifyMfaChallenge(ctx.actor!, input.body.code, clientInfoFromRequest(req, ctx));
      if (promoted) queueSessionCookie(req, promoted.token, promoted.expiresAt);
      return noContent();
    },
  }),
);
