import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveRole, archiveRoleSchema } from "@/server/roles";

/** POST /api/v1/roles/{id}/archive: the role stops granting access immediately; history stays. */
export const POST = defineRoute({
  schemas: { params: idParams, body: archiveRoleSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("permissions.archive"),
  handler: async ({ ctx, input }) => ok(await archiveRole(actorOf(ctx), ctx, input.params.id, input.body)),
});
