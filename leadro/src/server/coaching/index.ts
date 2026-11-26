// Coaching records (spec 10.4, 22.2): private by default, shared explicitly, archived never deleted.
export {
  createCoachingRecord,
  updateCoachingRecord,
  shareCoachingRecord,
  archiveCoachingRecord,
  getCoachingRecord,
  listCoachingRecords,
  supersedeCoachingRecordInTx,
  toCoachingRecordView,
} from "./coaching-records";
export type { CoachingRecordView, SupersedeCoachingRecordInput } from "./coaching-records";

// Manager context notes on metric values or periods (performance.edit / .view with the coaching field set).
export { createContextNote, shareContextNote, archiveContextNote, getContextNote, listContextNotes, toContextNoteView } from "./context-notes";
export type { ContextNoteView } from "./context-notes";

export { textDigest } from "./access";

export {
  createCoachingRecordSchema,
  updateCoachingRecordSchema,
  listCoachingRecordsQuerySchema,
  createContextNoteSchema,
  listContextNotesQuerySchema,
} from "./schemas";
export type {
  CreateCoachingRecordInput,
  UpdateCoachingRecordInput,
  ListCoachingRecordsQuery,
  CreateContextNoteInput,
  ListContextNotesQuery,
} from "./schemas";

// Self-service (`/api/v1/me/*`): the caller's own notes that were shared with them (no module permission).
export { listOwnSharedCoachingRecords, listOwnSharedContextNotes, ownCoachingRecordsQuerySchema, ownContextNotesQuerySchema } from "./self-service";
export type { OwnCoachingRecordsQuery, OwnContextNotesQuery } from "./self-service";
