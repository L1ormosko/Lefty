import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveLegalEntity, archiveSchema } from "@/server/organization";

/** POST /api/v1/organization/legal-entities/{id}/archive (tenant-wide `organization.archive`). */
export const POST = defineRoute({
  schemas: { params: idParams, body: archiveSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("organization.archive"),
  handler: async ({ ctx, input }) => ok(await archiveLegalEntity(actorOf(ctx), ctx, input.params.id, input.body)),
});
