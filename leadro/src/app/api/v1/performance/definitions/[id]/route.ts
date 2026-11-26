import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { definitionIdParams, getDefinition, updateDefinition, updateDefinitionSchema } from "@/server/performance";

/** GET /api/v1/performance/definitions/{id}: one version (404 when not visible to the caller). */
export const GET = defineRoute({
  schemas: { params: definitionIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view"),
  handler: async ({ ctx, input }) => ok(await getDefinition(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/performance/definitions/{id}: edits a DRAFT version without computed values. `performance.configure` (TENANT). */
export const PATCH = defineRoute({
  schemas: { params: definitionIdParams, body: updateDefinitionSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("performance.configure"),
  handler: async ({ ctx, input }) => ok(await updateDefinition(actorOf(ctx), ctx, input.params.id, input.body)),
});
