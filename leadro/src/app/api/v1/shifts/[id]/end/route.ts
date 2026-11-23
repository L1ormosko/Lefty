import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { endShift, endShiftSchema, shiftIdParams } from "@/server/shifts";
import { resolveShift } from "../../_lib/resolve-shift";

/**
 * POST /api/v1/shifts/{id}/end: end a shift by id. The technician ends their own; a manager ending or correcting
 * someone else's (`shifts.edit` over their unit) must give a `reason`.
 */
export const POST = defineRoute({
  schemas: { params: shiftIdParams, body: endShiftSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("shifts.edit", resolveShift),
  handler: async ({ ctx, input }) => ok((await endShift(actorOf(ctx), ctx, input.params.id, input.body)).shift),
});
