import { idParams } from "@/app/api/v1/_lib/params";
import { authenticateRequest, clientInfoFromRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute } from "@/server/core";
import { inviteEmployee, inviteEmployeeSchema } from "@/server/employees";

/**
 * POST /api/v1/employees/{id}/invitations: invite the employee to create a login. The single-use
 * link goes to the invitee through the notifier; the response never contains it.
 */
export const POST = defineRoute({
  schemas: { params: idParams, body: inviteEmployeeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ params: { id: string } }>("users.create", (_actor, { params }) => ({
    employeeId: params.id,
  })),
  idempotent: true,
  handler: async ({ req, ctx, input }) =>
    created(await inviteEmployee(actorOf(ctx), input.params.id, input.body, clientInfoFromRequest(req, ctx))),
});
