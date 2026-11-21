import { unitManagerParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, noContent } from "@/server/core";
import { unassignUnitManager } from "@/server/organization";

/** DELETE /api/v1/organization/units/{id}/managers/{managerId}: ends the assignment (history is kept). */
export const DELETE = defineRoute({
  schemas: { params: unitManagerParams },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("organization.assign", (_actor, { params }) => ({
    orgUnitId: params.id,
  })),
  handler: async ({ ctx, input }) => {
    await unassignUnitManager(actorOf(ctx), ctx, input.params.id, input.params.managerId);
    return noContent();
  },
});
