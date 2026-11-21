import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, noContent } from "@/server/core";
import { revokeAssignment, revokeAssignmentSchema } from "@/server/roles";

/** POST /api/v1/roles/assignments/{id}/revoke: ends the assignment now; the row stays as history. */
export const POST = defineRoute({
  schemas: { params: idParams, body: revokeAssignmentSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("permissions.assign"),
  handler: async ({ ctx, input }) => {
    await revokeAssignment(actorOf(ctx), ctx, input.params.id, input.body);
    return noContent();
  },
});
