import { arrivalParams, verifyArrival, verifyArrivalSchema } from "@/server/arrival";
import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { resolveJob } from "../../../../_lib/resolve-job";

/** POST /api/v1/jobs/{id}/arrivals/{arrivalId}/verify: a manager verifies or rejects an arrival, with a mandatory reason (`location.approve` over the job). */
export const POST = defineRoute({
  schemas: { params: arrivalParams, body: verifyArrivalSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("location.approve", resolveJob),
  handler: async ({ ctx, input }) => ok(await verifyArrival(actorOf(ctx), ctx, input.params.id, input.params.arrivalId, input.body)),
});
