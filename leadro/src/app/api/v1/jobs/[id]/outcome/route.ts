import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { jobIdParams, recordJobOutcome, recordOutcomeSchema } from "@/server/job-outcomes";
import { resolveJob } from "../../_lib/resolve-job";

/**
 * POST /api/v1/jobs/{id}/outcome: report the outcome of the job's current visit (§9.1). The job follows the outcome
 * through its lifecycle. `201` when recorded, `200` when the same `clientEventId` was already recorded (offline replay).
 */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: recordOutcomeSchema },
  authenticate: authenticateRequest,
  // Scope gate only (404 outside it): the service decides create vs. retroactive edit and the money field set.
  authorize: requirePermission("job_outcomes.view", resolveJob),
  idempotent: true,
  handler: async ({ ctx, input }) => {
    const result = await recordJobOutcome(actorOf(ctx), ctx, input.params.id, input.body);
    return respond(result.replayed ? 200 : 201, { data: result });
  },
});
