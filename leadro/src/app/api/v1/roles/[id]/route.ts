import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getRole, updateRole, updateRoleSchema } from "@/server/roles";

/** GET /api/v1/roles/{id}: the role with its permissions and qualifiers. */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("permissions.view"),
  handler: async ({ ctx, input }) => ok(await getRole(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/roles/{id}: name, description, MFA flag. Refused for a role assigned to the caller. */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateRoleSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("permissions.edit"),
  handler: async ({ ctx, input }) => ok(await updateRole(actorOf(ctx), ctx, input.params.id, input.body)),
});
