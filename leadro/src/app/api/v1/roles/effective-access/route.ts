import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { effectiveAccessQuerySchema, getEffectiveAccess } from "@/server/roles";

/** GET /api/v1/roles/effective-access?userId=: what the user can do now; add permission= for "why". */
export const GET = defineRoute({
  schemas: { query: effectiveAccessQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("permissions.view"),
  handler: async ({ ctx, input }) => ok(await getEffectiveAccess(actorOf(ctx), input.query)),
});
