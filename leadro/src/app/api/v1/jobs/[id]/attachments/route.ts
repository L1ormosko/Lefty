import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, respond } from "@/server/core";
import { listAttachments, listFieldRecordsQuerySchema, jobIdParams, recordAttachmentMetadata, recordAttachmentSchema } from "@/server/field-execution";
import { resolveJob } from "../../_lib/resolve-job";

/** GET /api/v1/jobs/{id}/attachments: attachment METADATA of the job, newest first (files are not stored: no storage provider is configured). */
export const GET = defineRoute({
  schemas: { params: jobIdParams, query: listFieldRecordsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.view", resolveJob),
  handler: async ({ ctx, input }) => respond(200, await listAttachments(actorOf(ctx), input.params.id, input.query)),
});

/** POST /api/v1/jobs/{id}/attachments: records the metadata of a captured photo, signature or document (§8.5). `201` when recorded, `200` when the same `clientEventId` was already recorded (offline replay). */
export const POST = defineRoute({
  schemas: { params: jobIdParams, body: recordAttachmentSchema },
  authenticate: authenticateRequest,
  // Scope gate only (404 outside it): the service re-checks `jobs.edit` over the job and the job's phase.
  authorize: requirePermission("jobs.edit", resolveJob),
  idempotent: true,
  handler: async ({ ctx, input }) => {
    const result = await recordAttachmentMetadata(actorOf(ctx), ctx, input.params.id, input.body);
    return respond(result.replayed ? 200 : 201, { data: result });
  },
});
