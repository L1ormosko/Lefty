import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { assignTraining, assignTrainingSchema, listAssignments, listAssignmentsQuerySchema } from "@/server/training";

/** GET /api/v1/training/assignments: assignments in the caller's scope, soonest due first (`overdue=true` filter). */
export const GET = defineRoute({
  schemas: { query: listAssignmentsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.view"),
  handler: async ({ ctx, input }) => respond(200, await listAssignments(actorOf(ctx), input.query)),
});

/** POST /api/v1/training/assignments: assigns a course to an employee (`training.assign` over the employee). */
export const POST = defineRoute({
  schemas: { body: assignTrainingSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("training.assign"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await assignTraining(actorOf(ctx), ctx, input.body)),
});
