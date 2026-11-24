import { jobIdParams, startWork, startWorkSchema } from "@/server/arrival";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";

/** POST /api/v1/jobs/{id}/start-work: the assigned technician starts the work (ARRIVED > IN_PROGRESS, stamps `startedAt`). Offline-safe. */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: startWorkSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.edit"),
  handler: async ({ ctx, input }) => {
    const { replayed: _replayed, ...body } = await startWork(actorOf(ctx), ctx, input.params.id, input.body);
    return ok(body);
  },
});
