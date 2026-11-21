import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { grantRoleSchema, grantRoleToUser, listAssignmentsQuerySchema, listRoleAssignments } from "@/server/roles";

/** GET /api/v1/roles/assignments: who holds which role, scope and expiry; scope-filtered by the target user. */
export const GET = defineRoute({
  schemas: { query: listAssignmentsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("permissions.view"),
  handler: async ({ ctx, input }) => respond(200, await listRoleAssignments(actorOf(ctx), input.query)),
});

/** POST /api/v1/roles/assignments: grant a role with explicit scopes and optional expiry (anti-escalation enforced). */
export const POST = defineRoute({
  schemas: { body: grantRoleSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("permissions.assign"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await grantRoleToUser(actorOf(ctx), ctx, input.body)),
});
