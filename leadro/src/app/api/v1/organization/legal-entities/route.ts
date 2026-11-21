import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import {
  createLegalEntity,
  createLegalEntitySchema,
  listLegalEntities,
  listLegalEntitiesQuerySchema,
} from "@/server/organization";

/** GET /api/v1/organization/legal-entities: paginated, scope-filtered, field-projected. */
export const GET = defineRoute({
  schemas: { query: listLegalEntitiesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("organization.view"),
  handler: async ({ ctx, input }) => respond(200, await listLegalEntities(actorOf(ctx), input.query)),
});

/** POST /api/v1/organization/legal-entities (tenant-wide `organization.create`). */
export const POST = defineRoute({
  schemas: { body: createLegalEntitySchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("organization.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createLegalEntity(actorOf(ctx), ctx, input.body)),
});
