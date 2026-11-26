import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getEmployeeDevelopment } from "@/server/development-dashboard";

/**
 * GET /api/v1/employees/{id}/development: the manager development dashboard of one employee (`performance.view` over the
 * employee; 404 outside the scope). Per-dimension values with sample sizes, their position among comparable colleagues in
 * the caller's scope, history and evidence links; coaching content only with the `coaching` field set. Never a combined score.
 */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view", (_actor, { params }: { params: { id: string } }) => ({ employeeId: params.id })),
  handler: async ({ ctx, input }) => ok(await getEmployeeDevelopment(actorOf(ctx), input.params.id)),
});
