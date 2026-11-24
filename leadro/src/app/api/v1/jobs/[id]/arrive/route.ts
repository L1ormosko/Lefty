import { arriveSchema, confirmArrival, jobIdParams } from "@/server/arrival";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok } from "@/server/core";

/**
 * POST /api/v1/jobs/{id}/arrive: the assigned technician confirms arrival at a job that is EN_ROUTE. The job moves to
 * ARRIVED; the server compares the reported position with the address and records the verdict (never proof). 201 for a
 * new arrival, 200 when a repeated `clientEventId` was answered from the first delivery. Access to the job is checked in the service.
 */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: arriveSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("location.create"),
  handler: async ({ ctx, input }) => {
    const { replayed, ...body } = await confirmArrival(actorOf(ctx), ctx, input.params.id, input.body);
    return replayed ? ok(body) : created(body);
  },
});
