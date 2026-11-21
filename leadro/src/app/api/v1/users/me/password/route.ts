import { authenticateRequest, changeOwnPassword, clientInfoFromRequest } from "@/server/auth";
import { actorOf, defineRoute, ok } from "@/server/core";
import { changePasswordSchema } from "@/server/users";

/**
 * POST /api/v1/users/me/password: change the signed-in user's password. Needs the current password;
 * every OTHER session of the user is signed out. Own data, so no permission applies.
 */
export const POST = defineRoute({
  schemas: { body: changePasswordSchema },
  authenticate: authenticateRequest,
  handler: async ({ req, ctx, input }) =>
    ok(await changeOwnPassword(actorOf(ctx), input.body, clientInfoFromRequest(req, ctx))),
});
