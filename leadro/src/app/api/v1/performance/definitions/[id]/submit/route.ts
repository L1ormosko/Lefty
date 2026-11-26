import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { definitionIdParams, submitDefinition, submitDefinitionSchema } from "@/server/performance";

/**
 * POST /api/v1/performance/definitions/{id}/submit: DRAFT -> PENDING_APPROVAL with an approval request. Without an active
 * publication policy: 409 `performance.publication_policy_missing` (a metric is never published without approval).
 */
export const POST = defineRoute({
  schemas: { params: definitionIdParams, body: submitDefinitionSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("performance.configure"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await submitDefinition(actorOf(ctx), ctx, input.params.id, input.body)),
});
