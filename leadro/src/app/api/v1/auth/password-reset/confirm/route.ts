import { z } from "zod";
import { clientInfoFromRequest, completePasswordReset } from "@/server/auth";
import { defineRoute, noContent } from "@/server/core";

/** POST /api/v1/auth/password-reset/confirm: sets a new password and signs out every session. */
export const POST = defineRoute({
  schemas: { body: z.object({ token: z.string().min(1).max(256), newPassword: z.string().min(1).max(1000) }) },
  handler: async ({ req, ctx, input }) => {
    await completePasswordReset(input.body, clientInfoFromRequest(req, ctx));
    return noContent();
  },
});
