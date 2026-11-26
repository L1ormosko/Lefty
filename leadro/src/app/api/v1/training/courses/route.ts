import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createCourse, createCourseSchema, listCourses, listCoursesQuerySchema } from "@/server/training";

/** GET /api/v1/training/courses: the course catalog by code (active only unless `includeArchived=true`). */
export const GET = defineRoute({
  schemas: { query: listCoursesQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => respond(200, await listCourses(actorOf(ctx), input.query)),
});

/** POST /api/v1/training/courses: adds a course. `training.manage` at TENANT scope. */
export const POST = defineRoute({
  schemas: { body: createCourseSchema },
  authenticate: authenticateRequest,
  authorize: requireTenantLevelPermission("training.manage"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createCourse(actorOf(ctx), ctx, input.body)),
});
