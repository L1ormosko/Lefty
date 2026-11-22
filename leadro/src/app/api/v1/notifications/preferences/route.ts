import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { listOwnPreferences, setOwnPreference, setPreferenceSchema } from "@/server/notifications";

/** GET /api/v1/notifications/preferences: the caller's stored channel opt-ins/outs. */
export const GET = defineRoute({
  authenticate: authenticateRequest,
  authorize: requirePermission("notifications.view"),
  handler: async ({ ctx }) => ok(await listOwnPreferences(actorOf(ctx))),
});

/** PUT /api/v1/notifications/preferences: opt in or out of one channel for one non-critical event type (or `*`). */
export const PUT = defineRoute({
  schemas: { body: setPreferenceSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("notifications.edit"),
  handler: async ({ ctx, input }) => ok(await setOwnPreference(actorOf(ctx), input.body)),
});
