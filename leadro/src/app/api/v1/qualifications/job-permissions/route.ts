import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createJobPermissionSchema, grantJobPermission, listByEmployeeQuerySchema, listJobPermissions } from "@/server/qualifications";

/** GET /api/v1/qualifications/job-permissions?employeeId=: the employee's job-type / job-category permissions. */
export const GET = defineRoute({
  schemas: { query: listByEmployeeQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ query: { employeeId: string } }>("qualifications.view", (_actor, { query }) => ({
    employeeId: query.employeeId,
  })),
  handler: async ({ ctx, input }) => respond(200, await listJobPermissions(actorOf(ctx), input.query)),
});

/** POST /api/v1/qualifications/job-permissions: authorizes an employee for a job type or category (`qualifications.approve`). */
export const POST = defineRoute({
  schemas: { body: createJobPermissionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ body: { employeeId: string } }>("qualifications.approve", (_actor, { body }) => ({
    employeeId: body.employeeId,
  })),
  handler: async ({ ctx, input }) => created(await grantJobPermission(actorOf(ctx), ctx, input.body)),
});
