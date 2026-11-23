import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";
import { startShift, startShiftSchema } from "@/server/shifts";

/**
 * POST /api/v1/shifts/start: the caller starts their own shift. 201 when a shift was created; 200 when one was already
 * running (idempotent) or a repeated `clientEventId` was answered from the first delivery.
 */
export const POST = defineRoute({
  schemas: { body: startShiftSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("shifts.create"),
  handler: async ({ ctx, input }) => {
    const result = await startShift(actorOf(ctx), ctx, input.body);
    return result.alreadyActive || result.replayed ? ok(result.shift) : created(result.shift);
  },
});
