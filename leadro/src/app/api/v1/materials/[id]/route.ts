import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getMaterial, materialIdParams, updateMaterial, updateMaterialSchema } from "@/server/materials";

/** GET /api/v1/materials/{id}: one material with its current and pending cost (cost fields only with the `cost` set). */
export const GET = defineRoute({
  schemas: { params: materialIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("materials.view"),
  handler: async ({ ctx, input }) => ok(await getMaterial(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/materials/{id}: catalog data (name, description, supplier, unit while no cost exists). `materials.edit` at TENANT scope. */
export const PATCH = defineRoute({
  schemas: { params: materialIdParams, body: updateMaterialSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("materials.edit"),
  handler: async ({ ctx, input }) => ok(await updateMaterial(actorOf(ctx), ctx, input.params.id, input.body)),
});
