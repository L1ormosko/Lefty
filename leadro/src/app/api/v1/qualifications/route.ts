import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import {
  createQualification,
  createQualificationSchema,
  listQualifications,
  listQualificationsQuerySchema,
} from "@/server/qualifications";

/** GET /api/v1/qualifications: employees' skills and credentials in the caller's scope, newest first. */
export const GET = defineRoute({
  schemas: { query: listQualificationsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("qualifications.view"),
  handler: async ({ ctx, input }) => respond(200, await listQualifications(actorOf(ctx), input.query)),
});

/** POST /api/v1/qualifications: records a skill or credential (starts PENDING_VERIFICATION). */
export const POST = defineRoute({
  schemas: { body: createQualificationSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ body: { employeeId: string } }>("qualifications.create", (_actor, { body }) => ({
    employeeId: body.employeeId,
  })),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createQualification(actorOf(ctx), ctx, input.body)),
});
