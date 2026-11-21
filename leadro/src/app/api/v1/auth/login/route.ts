import { z } from "zod";
import { defineRoute, ok } from "@/server/core";
import { clientInfoFromRequest, login, queueSessionCookie, withSessionCookie } from "@/server/auth";

const bodySchema = z.object({
  tenantSlug: z.string().min(1).max(100),
  email: z.string().min(1).max(320),
  // Deliberately no policy check here: login must not reveal the password rules to attackers.
  password: z.string().min(1).max(1000),
});

/** POST /api/v1/auth/login: company code + email + password. Sets the session cookie. */
export const POST = withSessionCookie(
  defineRoute({
    schemas: { body: bodySchema },
    handler: async ({ req, ctx, input }) => {
      const result = await login(input.body, clientInfoFromRequest(req, ctx));
      queueSessionCookie(req, result.token, result.expiresAt);
      return ok({
        userId: result.userId,
        expiresAt: result.expiresAt,
        mfaRequired: result.mfaRequired,
        mfaEnrollmentRequired: result.mfaEnrollmentRequired,
      });
    },
  }),
);
