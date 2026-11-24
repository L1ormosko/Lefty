import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { ConflictError, NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { recordJobEvent } from "@/server/jobs";
import { authorizeFieldRead, authorizeFieldWrite, runJobFieldWrite } from "./access";
import type { ListFieldRecordsQuery, RecordAttachmentInput } from "./schemas";
import { getStorageProvider, type UploadTarget } from "./storage";

/**
 * Photo, signature and document METADATA (§8.5). The device reports what it captured; the row waits as `PENDING_UPLOAD`.
 * The file itself goes through the `StorageProvider`, which is "not configured" in this build: asking for an upload
 * target is refused with `storage.not_configured` (409) rather than pretending (§28.3). `storageKey` and
 * `storageProvider` are never set here, so nothing is ever reported as stored.
 */

const ATTACHMENT_COLUMNS = {
  id: true,
  jobId: true,
  kind: true,
  status: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  checksumSha256: true,
  caption: true,
  capturedAt: true,
  recordedAt: true,
  uploadedById: true,
  clientEventId: true,
} satisfies Prisma.JobAttachmentSelect;
type AttachmentRow = Prisma.JobAttachmentGetPayload<{ select: typeof ATTACHMENT_COLUMNS }>;

/** `storage` tells the client whether the file can be uploaded at all, so the UI never promises what is impossible. */
const viewAttachment = (row: AttachmentRow): Record<string, unknown> => ({ ...row, storageConfigured: getStorageProvider().configured });

export interface RecordedAttachment {
  attachment: Record<string, unknown>;
  replayed: boolean;
}

async function readAttachment(tx: TenantTx, actor: Actor, jobId: string, attachmentId: string): Promise<Record<string, unknown>> {
  await authorizeFieldRead(tx, actor, jobId);
  const row = await tx.jobAttachment.findFirst({ where: { id: attachmentId, jobId, tenantId: actor.tenantId }, select: ATTACHMENT_COLUMNS });
  if (!row) throw new NotFoundError();
  return viewAttachment(row);
}

/** `POST /jobs/{id}/attachments`: records the metadata of a captured file (offline-safe through `clientEventId`). */
export async function recordAttachmentMetadata(actor: Actor, ctx: RequestContext, jobId: string, input: RecordAttachmentInput): Promise<RecordedAttachment> {
  const { result, replayed } = await runJobFieldWrite<Record<string, unknown>>(actor, {
    type: "job.attachment",
    jobId,
    envelope: input,
    content: { ...input, clientEventId: undefined, deviceId: undefined, occurredAt: undefined },
    payload: { kind: input.kind },
    apply: async (tx, occurredAt) => {
      await authorizeFieldWrite(tx, actor, jobId);
      const row = await tx.jobAttachment.create({
        data: {
          tenantId: actor.tenantId,
          jobId,
          kind: input.kind,
          status: "PENDING_UPLOAD",
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256 ?? null,
          caption: input.caption ?? null,
          capturedAt: input.capturedAt ?? occurredAt,
          uploadedById: actor.userId,
          clientEventId: input.clientEventId ?? null,
        },
        select: ATTACHMENT_COLUMNS,
      });
      await recordJobEvent(tx, actor.tenantId, jobId, { type: "job.attachment_recorded", actor, payload: { attachmentId: row.id, kind: row.kind } });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "job_attachment.record",
        targetType: "JobAttachment",
        targetId: row.id,
        // The file name and caption are free text about a customer's home: the trail keeps kind and size only.
        newValue: { jobId, kind: row.kind, sizeBytes: row.sizeBytes, status: row.status },
      });
      return { result: viewAttachment(row), entity: { type: "JobAttachment", id: row.id } };
    },
    replay: (tx, attachmentId) => readAttachment(tx, actor, jobId, attachmentId),
  });
  return { attachment: result, replayed };
}

/** `GET /jobs/{id}/attachments`: the job's attachment metadata, newest first. */
export async function listAttachments(actor: Actor, jobId: string, query: ListFieldRecordsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await authorizeFieldRead(tx, actor, jobId);
    const rows = await tx.jobAttachment.findMany({
      where: { tenantId: actor.tenantId, jobId },
      select: ATTACHMENT_COLUMNS,
      orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(viewAttachment), page: page.page };
  });
}

/**
 * `POST /jobs/{id}/attachments/{attachmentId}/upload`: asks the storage provider for a place to put the file.
 * With the default provider this is refused (409 `storage.not_configured`) and nothing changes.
 */
export async function requestAttachmentUpload(actor: Actor, jobId: string, attachmentId: string): Promise<UploadTarget> {
  const storage = getStorageProvider();
  const request = await withTenant(actor.tenantId, async (tx) => {
    // Lock and authorize as a write: the caller may add to this job. The job must still be open for field records.
    await authorizeFieldWrite(tx, actor, jobId);
    const row = await tx.jobAttachment.findFirst({ where: { id: attachmentId, jobId, tenantId: actor.tenantId }, select: ATTACHMENT_COLUMNS });
    if (!row) throw new NotFoundError();
    if (row.status === "STORED") throw new ConflictError({ message: "This file is already uploaded." });
    return { tenantId: actor.tenantId, jobId, attachmentId, contentType: row.contentType, sizeBytes: row.sizeBytes };
  });
  return storage.createUploadTarget(request);
}
