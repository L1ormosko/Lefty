import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getCurrentShift } from "@/server/shifts";

/** GET /api/v1/shifts/current: the caller's own active shift, or `{ "data": null }` when they are off shift. */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("shifts.view"),
  handler: async ({ ctx }) => ok(await getCurrentShift(actorOf(ctx))),
});
