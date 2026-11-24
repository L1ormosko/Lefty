import { registerBuiltInFieldSyncHandlers } from "./builtin";

export { processFieldSyncBatch, SYNC_STATUSES } from "./process";
export type { SyncBatchResult, SyncEventResult, SyncStatus } from "./process";
export { registerFieldSyncHandler, registeredFieldSyncTypes, clearFieldSyncHandlers } from "./registry";
export type { FieldSyncCall, FieldSyncEvent, FieldSyncHandler } from "./registry";
export { syncBatchSchema, syncEventSchema, MAX_SYNC_BATCH_EVENTS } from "./schemas";
export type { SyncBatchInput, SyncEventInput } from "./schemas";
export { registerBuiltInFieldSyncHandlers };

// The types of the modules that exist today are available as soon as this module is loaded.
registerBuiltInFieldSyncHandlers();
