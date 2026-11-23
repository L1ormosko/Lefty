import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { getOutcomeCorrections, outcomeIdParams } from "@/server/job-outcomes";
import { resolveOutcome } from "../../_lib/resolve-outcome";

/** GET /api/v1/job-outcomes/{id}/corrections: who changed what on an outcome, with the previous and new values (needs the financial set). */
export const GET = defineRoute({
  schemas: { params: outcomeIdParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("job_outcomes.edit", resolveOutcome),
  handler: async ({ ctx, input }) => ok(await getOutcomeCorrections(actorOf(ctx), input.params.id)),
});
