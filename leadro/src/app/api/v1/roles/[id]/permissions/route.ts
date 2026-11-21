import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { replacePermissionsSchema, replaceRolePermissions } from "@/server/roles";

/** PUT /api/v1/roles/{id}/permissions: replace the permission set (anti-escalation + self-assignment rules apply). */
export const PUT = defineRoute({
  schemas: { params: idParams, body: replacePermissionsSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("permissions.edit"),
  handler: async ({ ctx, input }) => ok(await replaceRolePermissions(actorOf(ctx), ctx, input.params.id, input.body)),
});
