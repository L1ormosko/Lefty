import { z } from "zod";
import { clientInfoFromRequest, requestPasswordReset } from "@/server/auth";
import { defineRoute, respond } from "@/server/core";

/** POST /api/v1/auth/password-reset/request: always answers 202, whether or not the account exists. */
export const POST = defineRoute({
  schemas: { body: z.object({ tenantSlug: z.string().min(1).max(100), email: z.string().min(1).max(320) }) },
  handler: async ({ req, ctx, input }) => {
    await requestPasswordReset(input.body, clientInfoFromRequest(req, ctx));
    return respond(202, { data: { accepted: true } });
  },
});
