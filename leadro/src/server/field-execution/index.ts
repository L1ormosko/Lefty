// Notes, additional work, customer approval (§8.5)
export { recordFieldNote, listFieldNotes } from "./notes";
export type { RecordedFieldNote } from "./notes";

// Materials used (§8.5)
export { recordMaterialUsed, listMaterialsUsed } from "./materials";
export type { RecordedMaterial } from "./materials";

// Attachment metadata and the storage boundary (§8.5, §28.3)
export { recordAttachmentMetadata, listAttachments, requestAttachmentUpload } from "./attachments";
export type { RecordedAttachment } from "./attachments";
export { getStorageProvider, setStorageProvider, notConfiguredStorage, STORAGE_NOT_CONFIGURED } from "./storage";
export type { StorageProvider, UploadRequest, UploadTarget } from "./storage";

// Completion forms (§8.6)
export { submitCompletion, listJobCompletions, getCompletionFormForJob } from "./completion";
export type { SubmittedCompletion } from "./completion";
export { listCompletionForms, getCompletionForm, createCompletionFormDraft, updateCompletionFormDraft, publishCompletionForm } from "./form-definitions";

export {
  jobIdParams,
  attachmentParams,
  completionFormIdParams,
  recordFieldNoteSchema,
  recordMaterialSchema,
  recordAttachmentSchema,
  submitCompletionSchema,
  listFieldRecordsQuerySchema,
  createCompletionFormSchema,
  updateCompletionFormSchema,
  listCompletionFormsQuerySchema,
  FIELD_NOTE_KINDS,
  ATTACHMENT_KINDS,
} from "./schemas";
export type {
  RecordFieldNoteInput,
  RecordMaterialInput,
  RecordAttachmentInput,
  SubmitCompletionInput,
  ListFieldRecordsQuery,
  CreateCompletionFormInput,
  UpdateCompletionFormInput,
  ListCompletionFormsQuery,
} from "./schemas";
