import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listShifts, listShiftsQuerySchema } from "@/server/shifts";

/** GET /api/v1/shifts: shifts the caller may see (own history for a technician, their people for a manager), newest start first. */
export const GET = defineRoute({
  schemas: { query: listShiftsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("shifts.view"),
  handler: async ({ ctx, input }) => respond(200, await listShifts(actorOf(ctx), input.query)),
});
