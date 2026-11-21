import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getEmployee, updateEmployee, updateEmployeeSchema } from "@/server/employees";

/** GET /api/v1/employees/{id} */
export const GET = defineRoute({
  schemas: { params: idParams },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("employees.view", (_actor, { params }) => ({
    employeeId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await getEmployee(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/employees/{id} */
export const PATCH = defineRoute({
  schemas: { params: idParams, body: updateEmployeeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("employees.edit", (_actor, { params }) => ({
    employeeId: params.id,
  })),
  handler: async ({ ctx, input }) => ok(await updateEmployee(actorOf(ctx), ctx, input.params.id, input.body)),
});
