import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveOrgUnit, archiveSchema } from "@/server/organization";

/** POST /api/v1/organization/units/{id}/archive: soft archive; refused while children or people remain. */
export const POST = defineRoute({
  schemas: { params: idParams, body: archiveSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("organization.archive", (_actor, { params }) => ({
    orgUnitId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await archiveOrgUnit(actorOf(ctx), ctx, input.params.id, input.body)),
});
