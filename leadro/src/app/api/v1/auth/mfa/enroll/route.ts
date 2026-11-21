import { defineRoute, ok } from "@/server/core";
import { authenticateMfaRequest, clientInfoFromRequest, startMfaEnrollment } from "@/server/auth";

/** POST /api/v1/auth/mfa/enroll: creates a TOTP seed (shown once). Confirm with /mfa/confirm. */
export const POST = defineRoute({
  authenticate: authenticateMfaRequest,
  handler: async ({ req, ctx }) => ok(await startMfaEnrollment(ctx.actor!, clientInfoFromRequest(req, ctx))),
});
