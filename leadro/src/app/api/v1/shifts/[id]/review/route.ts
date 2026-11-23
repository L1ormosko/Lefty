import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { reviewShiftException, reviewShiftSchema, shiftIdParams } from "@/server/shifts";
import { resolveShift } from "../../_lib/resolve-shift";

/** POST /api/v1/shifts/{id}/review: approve or reject a shift's start / end exception (`shifts.approve`; a note is required). */
export const POST = defineRoute({
  schemas: { params: shiftIdParams, body: reviewShiftSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("shifts.approve", resolveShift),
  handler: async ({ ctx, input }) => ok(await reviewShiftException(actorOf(ctx), ctx, input.params.id, input.body)),
});
