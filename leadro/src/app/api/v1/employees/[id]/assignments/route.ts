import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, pageQuerySchema, respond } from "@/server/core";
import { assignEmployeeSchema, assignEmployeeToUnit, listEmployeeAssignments } from "@/server/employees";

/** GET /api/v1/employees/{id}/assignments: placement history, newest first. */
export const GET = defineRoute({
  schemas: { params: idParams, query: pageQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("employees.view", (_actor, { params }) => ({
    employeeId: params.id,
  })),
  handler: async ({ ctx, input }) => respond(200, await listEmployeeAssignments(actorOf(ctx), input.params.id, input.query)),
});

/** POST /api/v1/employees/{id}/assignments: place or transfer (history is kept, never overwritten). */
export const POST = defineRoute({
  schemas: { params: idParams, body: assignEmployeeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("employees.assign", (_actor, { params }) => ({
    employeeId: params.id,
  })),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await assignEmployeeToUnit(actorOf(ctx), ctx, input.params.id, input.body)),
});
