import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { listCostVersions, listCostVersionsQuerySchema, materialIdParams, proposeCostSchema, proposeCostVersion } from "@/server/materials";

/** GET /api/v1/materials/{id}/costs: the cost history (every version), newest version first. Needs the `cost` set (403). */
export const GET = defineRoute({
  schemas: { params: materialIdParams, query: listCostVersionsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("materials.view"),
  handler: async ({ ctx, input }) => respond(200, await listCostVersions(actorOf(ctx), input.params.id, input.query)),
});

/**
 * POST /api/v1/materials/{id}/costs: proposes a new cost version. `201` with `approvalRequired: true` and the request id
 * when the MATERIAL_COST_CHANGE policy applies, or with the version already APPROVED when no policy does.
 * `materials.create` at TENANT scope plus the `cost` set (checked by the service).
 */
export const POST = defineRoute({
  schemas: { params: materialIdParams, body: proposeCostSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("materials.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await proposeCostVersion(actorOf(ctx), ctx, input.params.id, input.body)),
});
