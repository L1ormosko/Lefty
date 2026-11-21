import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getUser, updateUser, updateUserSchema } from "@/server/users";

/** GET /api/v1/users/{id}: the service resolves the user's employee and checks the scope (404 outside it). */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("users.view"),
  handler: async ({ ctx, input }) => ok(await getUser(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/users/{id}: locale / time-zone preference. */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateUserSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("users.edit"),
  handler: async ({ ctx, input }) => ok(await updateUser(actorOf(ctx), ctx, input.params.id, input.body)),
});
