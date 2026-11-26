import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createPlan, createPlanSchema, listPlans, listPlansQuerySchema } from "@/server/development";

/** GET /api/v1/development-plans: plans in the caller's `development_plans.view` scope, newest first. */
export const GET = defineRoute({
  schemas: { query: listPlansQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("development_plans.view"),
  handler: async ({ ctx, input }) => respond(200, await listPlans(actorOf(ctx), input.query)),
});

/** POST /api/v1/development-plans: a DRAFT plan for an employee. */
export const POST = defineRoute({
  schemas: { body: createPlanSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ body: { employeeId: string } }>("development_plans.create", (_actor, { body }) => ({ employeeId: body.employeeId })),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createPlan(actorOf(ctx), ctx, input.body)),
});
