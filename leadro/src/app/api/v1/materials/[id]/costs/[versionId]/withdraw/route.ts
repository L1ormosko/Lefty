import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { costVersionParams, withdrawCostSchema, withdrawCostVersion } from "@/server/materials";

/**
 * POST /api/v1/materials/{id}/costs/{versionId}/withdraw: withdraws a pending cost change (version CANCELLED, approval
 * request cancelled). The proposer, or `materials.create` at TENANT scope; both need the `cost` set (service checks).
 */
export const POST = defineRoute({
  schemas: { params: costVersionParams, body: withdrawCostSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("materials.view"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await withdrawCostVersion(actorOf(ctx), ctx, input.params.id, input.params.versionId, input.body)),
});
