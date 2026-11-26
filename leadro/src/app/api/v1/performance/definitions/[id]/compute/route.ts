import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { computeMetricValues, computeValuesSchema, definitionIdParams } from "@/server/performance";

/**
 * POST /api/v1/performance/definitions/{id}/compute: computes the version for a period and appends the values. Needs
 * `performance.manage` over every employee (checked by the service: 404 for one outside scope).
 */
export const POST = defineRoute({
  schemas: { params: definitionIdParams, body: computeValuesSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.manage"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await computeMetricValues(actorOf(ctx), ctx, input.params.id, input.body)),
});
