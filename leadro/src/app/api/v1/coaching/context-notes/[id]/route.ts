import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { getContextNote } from "@/server/coaching";
import { actorOf, defineRoute, ok } from "@/server/core";

/** GET /api/v1/coaching/context-notes/{id}: the service checks `performance.view` with the coaching set over the employee. */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view"),
  handler: async ({ ctx, input }) => ok(await getContextNote(actorOf(ctx), input.params.id)),
});
