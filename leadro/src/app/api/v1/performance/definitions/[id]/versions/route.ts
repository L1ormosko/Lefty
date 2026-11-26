import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { createDefinitionVersion, createVersionSchema, definitionIdParams } from "@/server/performance";

/** POST /api/v1/performance/definitions/{id}/versions: a new DRAFT version of the same key (copy + changes). `performance.configure`. */
export const POST = defineRoute({
  schemas: { params: definitionIdParams, body: createVersionSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("performance.configure"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createDefinitionVersion(actorOf(ctx), ctx, input.params.id, input.body)),
});
