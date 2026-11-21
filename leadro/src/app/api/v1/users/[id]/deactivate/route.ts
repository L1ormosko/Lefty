import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest, clientInfoFromRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { deactivateUser, deactivateUserSchema } from "@/server/users";

/** POST /api/v1/users/{id}/deactivate: disables the login and signs it out everywhere. */
export const POST = defineRoute({
  schemas: { params: idParams, body: deactivateUserSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("users.archive"),
  handler: async ({ req, ctx, input }) =>
    ok(await deactivateUser(actorOf(ctx), clientInfoFromRequest(req, ctx), input.params.id, input.body)),
});
