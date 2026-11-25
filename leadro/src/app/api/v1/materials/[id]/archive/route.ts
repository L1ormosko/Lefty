import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveMaterial, archiveMaterialSchema, materialIdParams } from "@/server/materials";

/** POST /api/v1/materials/{id}/archive: removes the material from the active catalog (history kept; a pending cost change is cancelled). */
export const POST = defineRoute({
  schemas: { params: materialIdParams, body: archiveMaterialSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("materials.archive"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await archiveMaterial(actorOf(ctx), ctx, input.params.id, input.body)),
});
