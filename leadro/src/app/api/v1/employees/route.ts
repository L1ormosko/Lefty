import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createEmployee, createEmployeeSchema, listEmployees, listEmployeesQuerySchema } from "@/server/employees";

/** GET /api/v1/employees: paginated, scope-filtered, each row projected to what its scope reveals. */
export const GET = defineRoute({
  schemas: { query: listEmployeesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("employees.view"),
  handler: async ({ ctx, input }) => respond(200, await listEmployees(actorOf(ctx), input.query)),
});

/** POST /api/v1/employees: the service checks `employees.create` over the initial org unit. */
export const POST = defineRoute({
  schemas: { body: createEmployeeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("employees.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createEmployee(actorOf(ctx), ctx, input.body)),
});
