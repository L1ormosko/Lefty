import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok, created, respond } from "@/server/core";
import { listLocationEvents, listLocationEventsQuerySchema, recordLocationEvent, recordLocationEventSchema } from "@/server/location";

/**
 * GET /api/v1/location-events: location history, newest first, scope-filtered (`location.view`, a sensitive permission).
 * Coordinates only for holders of the coordinates field set; everyone else gets time, kind, accuracy and verdicts.
 */
export const GET = defineRoute({
  schemas: { query: listLocationEventsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("location.view"),
  handler: async ({ ctx, input }) => respond(200, await listLocationEvents(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/location-events: a technician's own DEPARTURE or NAVIGATION_OPENED for an assigned job. 201 for a new
 * event, 200 when a repeated `clientEventId` was answered from the first delivery.
 */
export const POST = defineRoute({
  schemas: { body: recordLocationEventSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("location.create"),
  handler: async ({ ctx, input }) => {
    const result = await recordLocationEvent(actorOf(ctx), ctx, input.body);
    return result.replayed ? ok(result.event) : created(result.event);
  },
});
