import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getShift, shiftIdParams } from "@/server/shifts";
import { resolveShift } from "../_lib/resolve-shift";

/** GET /api/v1/shifts/{id}: one shift (`shifts.view` over it; out of scope is 404). */
export const GET = defineRoute({
  schemas: { params: shiftIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("shifts.view", resolveShift),
  handler: async ({ ctx, input }) => ok(await getShift(actorOf(ctx), input.params.id)),
});
