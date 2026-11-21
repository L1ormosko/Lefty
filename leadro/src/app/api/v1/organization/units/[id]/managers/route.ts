import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { assignManagerSchema, assignUnitManager, listManagersQuerySchema, listUnitManagers } from "@/server/organization";

/** GET /api/v1/organization/units/{id}/managers: current managers (history with includeEnded=true). */
export const GET = defineRoute({
  schemas: { params: idParams, query: listManagersQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("organization.view", (_actor, { params }) => ({
    orgUnitId: params.id,
  })),
  handler: async ({ ctx, input }) => respond(200, await listUnitManagers(actorOf(ctx), input.params.id, input.query)),
});

/** POST /api/v1/organization/units/{id}/managers: make an employee a manager of the unit. */
export const POST = defineRoute({
  schemas: { params: idParams, body: assignManagerSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("organization.assign", (_actor, { params }) => ({
    orgUnitId: params.id,
  })),
  handler: async ({ ctx, input }) => created(await assignUnitManager(actorOf(ctx), ctx, input.params.id, input.body)),
});
