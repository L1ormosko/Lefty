import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getLocationEvent, locationEventIdParams } from "@/server/location";

/** GET /api/v1/location-events/{id}: one event; the service checks `location.view` over its unit and projects coordinates away unless granted. */
export const GET = defineRoute({
  schemas: { params: locationEventIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("location.view"),
  handler: async ({ ctx, input }) => ok(await getLocationEvent(actorOf(ctx), input.params.id)),
});
