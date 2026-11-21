import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, pageQuerySchema, respond } from "@/server/core";
import { getRoleHistory } from "@/server/roles";

/** GET /api/v1/roles/{id}/history: permission history (who changed what, when, why), newest first. */
export const GET = defineRoute({
  schemas: { params: idParams, query: pageQuerySchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("permissions.view"),
  handler: async ({ ctx, input }) => respond(200, await getRoleHistory(actorOf(ctx), input.params.id, input.query)),
});
