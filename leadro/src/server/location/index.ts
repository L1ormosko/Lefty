// Writing events (internal writer for shifts, arrival and recovery; no coordinates in the result)
export { recordLocationEventInTx } from "./record";
export type { RecordLocationEventInput as RecordLocationEventInTxInput, RecordedLocationEvent, ReportedPosition } from "./record";

// Presence helper (INTERNAL: returns coordinates; derive distances / statuses from it, never return it)
export { latestValidLocation } from "./presence";
export type { LatestValidLocationOptions, ValidLocation } from "./presence";

// Retention
export { purgeExpiredCoordinates } from "./retention";
export type { PurgeResult } from "./retention";

// Settings
export { loadLocationSettings, DEFAULT_LOCATION_SETTINGS } from "./settings";
export type { LocationSettings } from "./settings";

// Offline gate shared by every field write (shifts, location, arrival, notes, ...)
export { runFieldEvent } from "./field-events";
export type { FieldEventRequest, FieldEventEntity, FieldEventHandlers, FieldEventOutcome } from "./field-events";

// API services
export { recordLocationEvent } from "./service";
export type { RecordedEventResult } from "./service";
export { listLocationEvents, getLocationEvent } from "./read";

export {
  LOCATION_EXCEPTIONS,
  LOCATION_EVENT_KINDS,
  LOCATION_SOURCES,
  TECHNICIAN_POSTED_KINDS,
  positionSchema,
  locationExceptionSchema,
  fieldEventEnvelope,
  recordLocationEventSchema,
  locationEventIdParams,
  listLocationEventsQuerySchema,
} from "./schemas";
export type { PositionInput, LocationExceptionInput, RecordLocationEventInput, ListLocationEventsQuery } from "./schemas";
