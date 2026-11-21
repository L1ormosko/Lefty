import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { terminateEmployee, terminateEmployeeSchema } from "@/server/employees";

/** POST /api/v1/employees/{id}/terminate: ends employment (soft), closes placements, deactivates the login. */
export const POST = defineRoute({
  schemas: { params: idParams, body: terminateEmployeeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("employees.archive", (_actor, { params }) => ({
    employeeId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await terminateEmployee(actorOf(ctx), ctx, input.params.id, input.body)),
});
