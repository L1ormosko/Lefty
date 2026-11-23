import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the location API and of the position blocks shifts accept. Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const LOCATION_EXCEPTIONS = ["GPS_DISABLED", "PERMISSION_DENIED", "POOR_SIGNAL", "DEVICE_OFFLINE", "OUTSIDE_GEOFENCE", "DELAYED", "OTHER"] as const;
export const LOCATION_EVENT_KINDS = ["SHIFT_START", "SHIFT_END", "ARRIVAL", "DEPARTURE", "NAVIGATION_OPENED", "VERIFICATION"] as const;
export const LOCATION_SOURCES = ["DEVICE_GPS", "GEOFENCE", "MANUAL", "MANAGER"] as const;

/** Kinds a technician may post directly (`POST /location-events`). Shift kinds belong to the shift endpoints, arrival kinds to arrival verification. */
export const TECHNICIAN_POSTED_KINDS = ["DEPARTURE", "NAVIGATION_OPENED"] as const;

/**
 * A position as the device reports it (spec 17.2): coordinates, the accuracy radius in meters and the DEVICE clock.
 * Accuracy is mandatory (a position without it is refused); the server adds its own receive time.
 */
export const positionSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100_000),
    deviceTime: instant,
  })
  .strict();
export type PositionInput = z.infer<typeof positionSchema>;

/** Why a position is missing or doubtful (spec 17.4). `OTHER` must be explained; every other code may carry a note. */
export const locationExceptionSchema = z
  .object({ code: z.enum(LOCATION_EXCEPTIONS), note: z.string().trim().min(1).max(500).optional() })
  .strict()
  .refine((value) => value.code !== "OTHER" || value.note !== undefined, { path: ["note"], message: "Explain what happened" });
export type LocationExceptionInput = z.infer<typeof locationExceptionSchema>;

/**
 * Offline-safe envelope (spec 8.7, 25.3) shared by every field write: a client-generated UUID makes the call
 * idempotent per employee, `occurredAt` is when it happened on the device (default: now).
 */
export const fieldEventEnvelope = {
  // Lower-cased so the same UUID written in two cases is one event (the unique key compares strings).
  clientEventId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
  occurredAt: instant.optional(),
  deviceId: z.string().trim().min(1).max(100).optional(),
};

/** `POST /location-events`: a technician's own event. Either a position or an exception, never both missing. */
export const recordLocationEventSchema = z
  .object({
    ...fieldEventEnvelope,
    kind: z.enum(TECHNICIAN_POSTED_KINDS),
    jobId: id,
    position: positionSchema.optional(),
    exception: locationExceptionSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.position && value.exception), { path: ["exception"], message: "Send a position or an exception, not both" })
  // A departure without a position is a manual entry: say why (spec 17.4). Navigation-opened is informational and may have neither.
  .refine((value) => value.kind !== "DEPARTURE" || value.position !== undefined || value.exception !== undefined, {
    path: ["exception"],
    message: "Send a position, or say why there is none",
  });
export type RecordLocationEventInput = z.infer<typeof recordLocationEventSchema>;

export const locationEventIdParams = z.object({ id });

export const listLocationEventsQuerySchema = pageQuerySchema.extend({
  employeeId: id.optional(),
  jobId: id.optional(),
  shiftId: id.optional(),
  kind: z.enum(LOCATION_EVENT_KINDS).optional(),
  from: instant.optional(),
  to: instant.optional(),
});
export type ListLocationEventsQuery = z.infer<typeof listLocationEventsQuerySchema>;
