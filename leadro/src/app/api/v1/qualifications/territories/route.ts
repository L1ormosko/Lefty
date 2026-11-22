import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createTerritory, createTerritorySchema, listByEmployeeQuerySchema, listTerritories } from "@/server/qualifications";

/** GET /api/v1/qualifications/territories?employeeId=: the employee's service territories, oldest first. */
export const GET = defineRoute({
  schemas: { query: listByEmployeeQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ query: { employeeId: string } }>("qualifications.view", (_actor, { query }) => ({
    employeeId: query.employeeId,
  })),
  handler: async ({ ctx, input }) => respond(200, await listTerritories(actorOf(ctx), input.query)),
});

/** POST /api/v1/qualifications/territories: needs `qualifications.edit` over the employee AND the unit. */
export const POST = defineRoute({
  schemas: { body: createTerritorySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ body: { employeeId: string } }>("qualifications.edit", (_actor, { body }) => ({
    employeeId: body.employeeId,
  })),
  handler: async ({ ctx, input }) => created(await createTerritory(actorOf(ctx), ctx, input.body)),
});
