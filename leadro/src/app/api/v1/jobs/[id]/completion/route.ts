import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { jobIdParams, listFieldRecordsQuerySchema, listJobCompletions, submitCompletion, submitCompletionSchema } from "@/server/field-execution";
import { resolveJob } from "../../_lib/resolve-job";

/** GET /api/v1/jobs/{id}/completion: the completion forms submitted for the job (one per visit), newest first. */
export const GET = defineRoute({
  schemas: { params: jobIdParams, query: listFieldRecordsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view", resolveJob),
  handler: async ({ ctx, input }) => respond(200, await listJobCompletions(actorOf(ctx), input.params.id, input.query)),
});

/**
 * POST /api/v1/jobs/{id}/completion: submits the completion form of the current visit (§8.6), validated against the job
 * type's active form version. `201` when stored, `200` for an offline replay of the same `clientEventId`.
 */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: submitCompletionSchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.edit", resolveJob),
  idempotent: true,
  handler: async ({ ctx, input }) => {
    const result = await submitCompletion(actorOf(ctx), ctx, input.params.id, input.body);
    return respond(result.replayed ? 200 : 201, { data: result });
  },
});
