import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createMaterial, createMaterialSchema, listMaterials, listMaterialsQuerySchema } from "@/server/materials";

/** GET /api/v1/materials: the material catalog by code (active only unless `includeArchived=true`); costs only with the `cost` set. */
export const GET = defineRoute({
  schemas: { query: listMaterialsQuerySchema },
  authenticate: authenticateRequest,
  // The catalog is tenant-wide reference data: any `materials.view` grant reads it (technicians pick from it).
  authorize: requirePermission("materials.view"),
  handler: async ({ ctx, input }) => respond(200, await listMaterials(actorOf(ctx), input.query)),
});

/** POST /api/v1/materials: adds a material (no cost yet). `materials.create` at TENANT scope. */
export const POST = defineRoute({
  schemas: { body: createMaterialSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("materials.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createMaterial(actorOf(ctx), ctx, input.body)),
});
