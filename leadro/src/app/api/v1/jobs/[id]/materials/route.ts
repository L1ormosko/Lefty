import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listMaterialsUsed, listFieldRecordsQuerySchema, jobIdParams, recordMaterialUsed, recordMaterialSchema } from "@/server/field-execution";
import { resolveJob } from "../../_lib/resolve-job";

/** GET /api/v1/jobs/{id}/materials: the materials used on the job, newest first. */
export const GET = defineRoute({
  schemas: { params: jobIdParams, query: listFieldRecordsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view", resolveJob),
  handler: async ({ ctx, input }) => respond(200, await listMaterialsUsed(actorOf(ctx), input.params.id, input.query)),
});

/** POST /api/v1/jobs/{id}/materials: records a material used (§8.5). `201` when recorded, `200` when the same `clientEventId` was already recorded (offline replay). */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: recordMaterialSchema },
  authenticate: authenticateRequest,
  // Scope gate only (404 outside it): the service re-checks `jobs.edit` over the job and the job's phase.
  authorize: requirePermission("jobs.edit", resolveJob),
  idempotent: true,
  handler: async ({ ctx, input }) => {
    const result = await recordMaterialUsed(actorOf(ctx), ctx, input.params.id, input.body);
    return respond(result.replayed ? 200 : 201, { data: result });
  },
});
