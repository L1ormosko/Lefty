import { employeeAssignmentParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { endAssignmentSchema, endEmployeeAssignment } from "@/server/employees";

/** POST /api/v1/employees/{id}/assignments/{assignmentId}/end: end a secondary or temporary placement. */
export const POST = defineRoute({
  schemas: { params: employeeAssignmentParams, body: endAssignmentSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("employees.assign", (_actor, { params }) => ({
    employeeId: params.id,
  })),
  handler: async ({ ctx, input }) =>
    ok(await endEmployeeAssignment(actorOf(ctx), ctx, input.params.id, input.params.assignmentId, input.body)),
});
