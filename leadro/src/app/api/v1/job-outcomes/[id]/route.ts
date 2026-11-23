import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { correctJobOutcome, correctOutcomeSchema, getJobOutcome, outcomeIdParams } from "@/server/job-outcomes";
import { resolveOutcome } from "../_lib/resolve-outcome";

/** GET /api/v1/job-outcomes/{id}: one outcome. */
export const GET = defineRoute({
  schemas: { params: outcomeIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("job_outcomes.view", resolveOutcome),
  handler: async ({ ctx, input }) => ok(await getJobOutcome(actorOf(ctx), input.params.id)),
});

/** PATCH /api/v1/job-outcomes/{id}: correct reason, notes, amounts or payment (managers; needs a correction reason). */
export const PATCH = defineRoute({
  schemas: { params: outcomeIdParams, body: correctOutcomeSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("job_outcomes.edit", resolveOutcome),
  handler: async ({ ctx, input }) => ok(await correctJobOutcome(actorOf(ctx), ctx, input.params.id, input.body)),
});
