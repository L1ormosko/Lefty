import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getCourse, trainingIdParams, updateCourse, updateCourseSchema } from "@/server/training";

/** GET /api/v1/training/courses/{id}. */
export const GET = defineRoute({
  schemas: { params: trainingIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => ok(await getCourse(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/training/courses/{id}: name, category, description, certification, validity (the code is fixed). */
export const PATCH = defineRoute({
  schemas: { params: trainingIdParams, body: updateCourseSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("training.manage"),
  handler: async ({ ctx, input }) => ok(await updateCourse(actorOf(ctx), ctx, input.params.id, input.body)),
});
