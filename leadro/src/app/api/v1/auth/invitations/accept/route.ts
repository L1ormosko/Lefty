import { z } from "zod";
import { acceptInvitation, clientInfoFromRequest } from "@/server/auth";
import { created, defineRoute } from "@/server/core";

/** POST /api/v1/auth/invitations/accept: sets the password and activates the invited account. */
export const POST = defineRoute({
  schemas: { body: z.object({ token: z.string().min(1).max(256), password: z.string().min(1).max(1000) }) },
  handler: async ({ req, ctx, input }) => created(await acceptInvitation(input.body, clientInfoFromRequest(req, ctx))),
});
