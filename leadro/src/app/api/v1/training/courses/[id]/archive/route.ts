import { authenticateRequest } from "@/server/auth";
import { requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { archiveCourse, archiveCourseSchema, trainingIdParams } from "@/server/training";

/** POST /api/v1/training/courses/{id}/archive: no new assignments for the course; history is kept. */
export const POST = defineRoute({
  schemas: { params: trainingIdParams, body: archiveCourseSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("training.manage"),
  idempotent: true,
  handler: async ({ ctx, input }) => ok(await archiveCourse(actorOf(ctx), ctx, input.params.id, input.body)),
});
