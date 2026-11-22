import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { endGrantSchema, endJobPermission } from "@/server/qualifications";

/** POST /api/v1/qualifications/job-permissions/{id}/end: ends the permission now (`qualifications.approve`). */
export const POST = defineRoute({
  schemas: { params: idParams, body: endGrantSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.approve"),
  handler: async ({ ctx, input }) => ok(await endJobPermission(actorOf(ctx), ctx, input.params.id, input.body)),
});
