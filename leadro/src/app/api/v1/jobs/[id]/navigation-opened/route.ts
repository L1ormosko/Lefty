import { jobIdParams, navigationOpenedSchema, recordNavigationOpened } from "@/server/arrival";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";

/** POST /api/v1/jobs/{id}/navigation-opened: the technician opened navigation for the job. Informational: never changes the job status, never an arrival. */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: navigationOpenedSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("location.create"),
  handler: async ({ ctx, input }) => {
    const result = await recordNavigationOpened(actorOf(ctx), ctx, input.params.id, input.body);
    return result.replayed ? ok(result.event) : created(result.event);
  },
});
