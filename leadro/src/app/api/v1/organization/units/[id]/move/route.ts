import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { moveOrgUnit, moveOrgUnitSchema } from "@/server/organization";

/** POST /api/v1/organization/units/{id}/move: re-parent (cycle, archived-parent and type rules apply). */
export const POST = defineRoute({
  schemas: { params: idParams, body: moveOrgUnitSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("organization.edit", (_actor, { params }) => ({
    orgUnitId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await moveOrgUnit(actorOf(ctx), ctx, input.params.id, input.body)),
});
