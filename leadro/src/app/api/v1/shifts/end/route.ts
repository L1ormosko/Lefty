import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { endShift, endShiftSchema } from "@/server/shifts";

/** POST /api/v1/shifts/end: the caller ends their own current shift (idempotent: an already ended shift is returned unchanged). */
export const POST = defineRoute({
  schemas: { body: endShiftSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("shifts.edit"),
  handler: async ({ ctx, input }) => ok((await endShift(actorOf(ctx), ctx, undefined, input.body)).shift),
});
