import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { endGrantSchema, endTerritory } from "@/server/qualifications";

/** POST /api/v1/qualifications/territories/{id}/end: ends the territory now (rows are never deleted). */
export const POST = defineRoute({
  schemas: { params: idParams, body: endGrantSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.edit"),
  handler: async ({ ctx, input }) => ok(await endTerritory(actorOf(ctx), ctx, input.params.id, input.body)),
});
