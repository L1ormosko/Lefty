import { authenticateRequest } from "@/server/auth";
import { requirePermission } from "@/server/authz";
import { actorOf, defineRoute, ok } from "@/server/core";
import { attachmentParams, requestAttachmentUpload } from "@/server/field-execution";
import { resolveJob } from "../../../../_lib/resolve-job";

/**
 * POST /api/v1/jobs/{id}/attachments/{attachmentId}/upload: asks the storage provider for an upload target. While no
 * provider is configured this answers `409` with detail code `storage.not_configured` and changes nothing.
 */
export const POST = defineRoute({
  schemas: { params: attachmentParams },
  authenticate: authenticateRequest,
  authorize: requirePermission("jobs.edit", resolveJob),
  handler: async ({ ctx, input }) => ok(await requestAttachmentUpload(actorOf(ctx), input.params.id, input.params.attachmentId)),
});
