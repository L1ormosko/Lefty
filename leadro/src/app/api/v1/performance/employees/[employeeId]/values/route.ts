import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { employeeIdParams, employeeValuesQuerySchema, listEmployeeCurrentValues } from "@/server/performance";

/**
 * GET /api/v1/performance/employees/{employeeId}/values: the employee's CURRENT value per definition version, period and
 * breakdown. `performance.view` over the employee (404 outside scope); each entry stands alone (no total or rank).
 */
export const GET = defineRoute({
  schemas: { params: employeeIdParams, query: employeeValuesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("performance.view", (_actor, { params }: { params: { employeeId: string } }) => ({ employeeId: params.employeeId })),
  handler: async ({ ctx, input }) => ok(await listEmployeeCurrentValues(actorOf(ctx), input.params.employeeId, input.query)),
});
