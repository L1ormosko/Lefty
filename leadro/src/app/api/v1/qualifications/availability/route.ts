import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createAvailability, createAvailabilitySchema, listAvailability, listByEmployeeQuerySchema } from "@/server/qualifications";

/** GET /api/v1/qualifications/availability?employeeId=: weekly windows, then exceptions. */
export const GET = defineRoute({
  schemas: { query: listByEmployeeQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ query: { employeeId: string } }>("qualifications.view", (_actor, { query }) => ({
    employeeId: query.employeeId,
  })),
  handler: async ({ ctx, input }) => respond(200, await listAvailability(actorOf(ctx), input.query)),
});

/** POST /api/v1/qualifications/availability: a weekly window or a dated exception (time off, extra shift). */
export const POST = defineRoute({
  schemas: { body: createAvailabilitySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission<{ body: { employeeId: string } }>("qualifications.edit", (_actor, { body }) => ({
    employeeId: body.employeeId,
  })),
  handler: async ({ ctx, input }) => created(await createAvailability(actorOf(ctx), ctx, input.body)),
});
