import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { cloneRole, cloneRoleSchema } from "@/server/roles";

/** POST /api/v1/roles/{id}/clone: copy a role (e.g. a template) under a new name. */
export const POST = defineRoute({
  schemas: { params: idParams, body: cloneRoleSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("permissions.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await cloneRole(actorOf(ctx), ctx, input.params.id, input.body)),
});
