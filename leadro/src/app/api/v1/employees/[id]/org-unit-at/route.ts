import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getOrgUnitAtAsActor, orgUnitAtQuerySchema } from "@/server/employees";

/** GET /api/v1/employees/{id}/org-unit-at?date=ISO: the org unit they were placed in on that date (null if none). */
export const GET = defineRoute({
  schemas: { params: idParams, query: orgUnitAtQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("employees.view", (_actor, { params }) => ({
    employeeId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await getOrgUnitAtAsActor(actorOf(ctx), input.params.id, input.query.date)),
});
