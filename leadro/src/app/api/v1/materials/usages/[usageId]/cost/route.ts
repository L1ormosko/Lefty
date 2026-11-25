import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { costMaterialUsage, costUsageSchema, materialUsageJobResourceRef, usageIdParams } from "@/server/materials";

/**
 * POST /api/v1/materials/usages/{usageId}/cost: costs one material line (optionally linking it to `materialId` first).
 * 409 with a detail code when it cannot be costed (already costed, not linked, unit mismatch, no cost in effect).
 */
export const POST = defineRoute({
  schemas: { params: usageIdParams, body: costUsageSchema },
  authenticate: authenticateRequest,
  // The usage's job decides the scope (404 outside it); the service re-checks and requires the `cost` set.
  authorize: requirePermission("jobs.view", (actor, { params }: { params: { usageId: string } }, tx) => materialUsageJobResourceRef(tx, actor.tenantId, params.usageId)),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await costMaterialUsage(actorOf(ctx), ctx, input.params.usageId, input.body)),
});
