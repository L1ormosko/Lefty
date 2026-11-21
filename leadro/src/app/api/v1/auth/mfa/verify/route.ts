import { z } from "zod";
import { defineRoute, noContent } from "@/server/core";
import { authenticateMfaRequest, clientInfoFromRequest, verifyMfaChallenge } from "@/server/auth";

/** POST /api/v1/auth/mfa/verify: login step 2. Promotes an MFA-pending session to a full one. */
export const POST = defineRoute({
  schemas: { body: z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }) },
  authenticate: authenticateMfaRequest,
  handler: async ({ req, ctx, input }) => {
    await verifyMfaChallenge(ctx.actor!, input.body.code, clientInfoFromRequest(req, ctx));
    return noContent();
  },
});
