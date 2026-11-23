import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, respond } from "@/server/core";
import { createFollowUp, createFollowUpSchema, listFollowUps, listFollowUpsQuerySchema } from "@/server/follow-ups";

/** GET /api/v1/follow-ups: soonest due first; only tasks in the caller's scope whose target the caller may also view. */
export const GET = defineRoute({
  schemas: { query: listFollowUpsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("follow_ups.view"),
  handler: async ({ ctx, input }) => respond(200, await listFollowUps(actorOf(ctx), input.query)),
});

/**
 * POST /api/v1/follow-ups: creates a task about a lead, customer, job or recovery case. The service checks
 * `follow_ups.create` over the target's service area, view access to the target, and `follow_ups.assign` when the
 * assignee is somebody else. Accepts `clientEventId` + `occurredAt` (offline replay is safe).
 */
export const POST = defineRoute({
  schemas: { body: createFollowUpSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("follow_ups.create"),
  idempotent: true,
  handler: async ({ ctx, input }) => created(await createFollowUp(actorOf(ctx), ctx, input.body)),
});
