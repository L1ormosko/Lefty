import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createRole, createRoleSchema, listRoles, listRolesQuerySchema } from "@/server/roles";

/** GET /api/v1/roles: paginated. Roles are tenant-level, so only a tenant-wide grant sees any. */
export const GET = defineRoute({
  schemas: { query: listRolesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("permissions.view"),
  handler: async ({ ctx, input }) => respond(200, await listRoles(actorOf(ctx), input.query)),
});

/** POST /api/v1/roles: custom role; the caller must hold every permission they put in it. */
export const POST = defineRoute({
  schemas: { body: createRoleSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("permissions.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createRole(actorOf(ctx), ctx, input.body)),
});
