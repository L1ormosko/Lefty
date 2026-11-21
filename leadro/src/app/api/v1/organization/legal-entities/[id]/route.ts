import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getLegalEntity, updateLegalEntity, updateLegalEntitySchema } from "@/server/organization";

/** GET /api/v1/organization/legal-entities/{id} */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("organization.view", (_actor, { params }) => ({
    legalEntityId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await getLegalEntity(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/organization/legal-entities/{id} (tenant-wide `organization.edit`). */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateLegalEntitySchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("organization.edit"),
  handler: async ({ ctx, input }) => ok(await updateLegalEntity(actorOf(ctx), ctx, input.params.id, input.body)),
});
