import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getOrgUnit, updateOrgUnit, updateOrgUnitSchema } from "@/server/organization";

/** GET /api/v1/organization/units/{id} */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("organization.view", (_actor, { params }) => ({
    orgUnitId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await getOrgUnit(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/organization/units/{id}: rename / edit attributes (the type never changes). */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateOrgUnitSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("organization.edit", (_actor, { params }) => ({
    orgUnitId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await updateOrgUnit(actorOf(ctx), ctx, input.params.id, input.body)),
});
