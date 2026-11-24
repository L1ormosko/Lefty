import { ConflictError } from "@/server/core";

/**
 * File storage boundary (§8.5 photos, §28.3 no fake integrations). No object store is wired up in this build, so the
 * default provider says so and every upload is REFUSED with a truthful error. Attachment METADATA is still recorded
 * (the device captured the file; the row waits as `PENDING_UPLOAD`), but nothing ever claims a file is stored without
 * a provider that holds it (DB CHECK `job_attachment_stored_needs_key`).
 *
 * A real provider (S3, GCS, a local disk for development) implements `StorageProvider` and is installed once at start-up
 * with `setStorageProvider`; no other code changes.
 */

export interface UploadTarget {
  /** Where the device sends the bytes (a pre-signed URL for an object store). */
  url: string;
  /** Key under which the provider will hold the file; stored on the attachment once the upload is confirmed. */
  storageKey: string;
  expiresAt: Date;
}

export interface UploadRequest {
  tenantId: string;
  jobId: string;
  attachmentId: string;
  contentType: string;
  sizeBytes: number;
}

export interface StorageProvider {
  /** Stable name stored with each stored attachment (`JobAttachment.storageProvider`). */
  readonly name: string;
  /** False for the default: nothing can be uploaded. */
  readonly configured: boolean;
  /** A short-lived target the device can upload one file to. */
  createUploadTarget(request: UploadRequest): Promise<UploadTarget>;
}

/** Detail code clients and the UI key their "storage is not set up" message on. */
export const STORAGE_NOT_CONFIGURED = "storage.not_configured";

/** The default: refuses everything, truthfully. */
export const notConfiguredStorage: StorageProvider = {
  name: "none",
  configured: false,
  createUploadTarget: () =>
    Promise.reject(
      new ConflictError({
        message: "File storage is not configured for this deployment, so photos and documents cannot be uploaded yet. Their details are saved and will be uploaded once storage is set up.",
        details: [{ field: "storage", code: STORAGE_NOT_CONFIGURED, message: "No storage provider is configured." }],
      }),
    ),
};

let provider: StorageProvider = notConfiguredStorage;

/** The provider uploads go through (the "not configured" one unless start-up installed another). */
export const getStorageProvider = (): StorageProvider => provider;

/** Installs a provider (start-up, tests). Pass nothing to go back to "not configured". */
export function setStorageProvider(next: StorageProvider = notConfiguredStorage): void {
  provider = next;
}
