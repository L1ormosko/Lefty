import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createOrgUnit, createOrgUnitSchema, listOrgUnits, listOrgUnitsQuerySchema } from "@/server/organization";

/** GET /api/v1/organization/units: paginated, scope-filtered, field-projected. */
export const GET = defineRoute({
  schemas: { query: listOrgUnitsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("organization.view"),
  handler: async ({ ctx, input }) => respond(200, await listOrgUnits(actorOf(ctx), input.query)),
});

/** POST /api/v1/organization/units: the service checks `organization.create` over the parent unit. */
export const POST = defineRoute({
  schemas: { body: createOrgUnitSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("organization.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createOrgUnit(actorOf(ctx), ctx, input.body)),
});
