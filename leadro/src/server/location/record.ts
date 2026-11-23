import type { LocationEventKind, LocationException, LocationSource, LocationVerification } from "@prisma/client";
import { checkOccurredAt, isAccurateEnough } from "@/lib/location-rules";
import { ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { orgUnitAtInTx } from "@/server/employees";
import { loadLocationSettings } from "./settings";

/** A position as the device reported it. The accuracy radius is mandatory (spec 17.2). */
export interface ReportedPosition {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy radius in meters. Stored rounded up to a whole meter. */
  accuracyM: number;
}

export interface RecordLocationEventInput {
  tenantId: string;
  /** The employee the event is ABOUT (a technician's own events; a manager's entry names the technician here). */
  employeeId: string;
  kind: LocationEventKind;
  source: LocationSource;
  /** Absent for a manual / manager entry, a failed capture (`exception`) or a pure NAVIGATION_OPENED. */
  position?: ReportedPosition;
  /** The device clock when the position was taken. Required for DEVICE_GPS and GEOFENCE; null for MANUAL / MANAGER. */
  deviceTime?: Date | null;
  shiftId?: string;
  jobId?: string;
  /** Defaults to the employee's primary placement at `serverTime` (so manager scope does not depend on later moves). */
  orgUnitId?: string | null;
  deviceId?: string;
  exception?: LocationException;
  exceptionNote?: string;
  /** Required when `source` is MANAGER: who entered it. */
  recordedByUserId?: string;
  /** The `FieldEvent` that produced this event (offline idempotency link). */
  fieldEventId?: string;
  /** Arrival checks only: the straight-line distance to the job address and the radius it was judged against (both or neither). */
  distance?: { distanceToJobM: number; geofenceRadiusM: number };
  /** What the server concluded; defaults to UNVERIFIED. A radius verdict needs a position and a distance (DB CHECK). */
  verification?: LocationVerification;
}

/**
 * What a caller may learn about the event it just wrote. Deliberately WITHOUT coordinates: only the location
 * module's own read path (`listLocationEvents`) can reveal them, and only to holders of the coordinates field set.
 */
export interface RecordedLocationEvent {
  id: string;
  kind: LocationEventKind;
  source: LocationSource;
  accuracyM: number | null;
  /** The position is accurate enough (tenant setting) to count as evidence. False when there is no position. */
  usableAsEvidence: boolean;
  hasPosition: boolean;
  deviceTime: Date | null;
  serverTime: Date;
  verification: LocationVerification;
}

const DEVICE_SOURCES: LocationSource[] = ["DEVICE_GPS", "GEOFENCE"];
const roundCoordinate = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function refuse(field: string, message: string): never {
  throw new ValidationError({ message, field });
}

/** Everything that can be checked without the database. Throws `ValidationError`; the DB CHECKs are the second line. */
function validate(input: RecordLocationEventInput, now: Date): void {
  const { position } = input;
  if (position) {
    if (!Number.isFinite(position.latitude) || position.latitude < -90 || position.latitude > 90) refuse("position.latitude", "Latitude must be between -90 and 90.");
    if (!Number.isFinite(position.longitude) || position.longitude < -180 || position.longitude > 180) refuse("position.longitude", "Longitude must be between -180 and 180.");
    // §17.2: a position without its accuracy is not recorded; accuracy is what makes it honest.
    if (!Number.isFinite(position.accuracyM) || position.accuracyM < 0 || position.accuracyM > 100_000) refuse("position.accuracyM", "The accuracy radius in meters is required (0 to 100000).");
  }
  if (DEVICE_SOURCES.includes(input.source)) {
    if (!position) refuse("position", "A device-reported event needs a position.");
    if (!input.deviceTime) refuse("deviceTime", "A device-reported event needs the device time.");
  }
  if (input.deviceTime && checkOccurredAt(input.deviceTime, now) === "IN_THE_FUTURE") refuse("deviceTime", "The device time is in the future.");
  if (input.source === "MANAGER" && !input.recordedByUserId) refuse("recordedByUserId", "A manager entry records who made it.");
  if (input.exception === "OTHER" && !input.exceptionNote?.trim()) refuse("exception.note", "Explain what happened.");
  if (["ARRIVAL", "DEPARTURE", "NAVIGATION_OPENED"].includes(input.kind) && !input.jobId) refuse("jobId", "This kind of event belongs to a job.");
  if (["SHIFT_START", "SHIFT_END"].includes(input.kind) && !input.shiftId) refuse("shiftId", "A shift event belongs to a shift.");
}

/**
 * Appends one location event (spec 17): the ONLY writer of `LocationEvent`. Event-based (spec 17.1): callers are
 * shift start / end, departure, navigation-opened, arrival and approved verification; nothing polls.
 *
 * Validates what the DB CHECKs also guard, with client-safe messages: accuracy is mandatory with a position, device
 * sources carry the device clock (the server clock `serverTime` is always stamped by the database), a manager entry
 * names its author. Does NOT authorize: callers (shifts, arrival, the API service) check permission first, and that
 * is why the result carries no coordinates. Runs in the caller's tenant transaction.
 *
 * NAVIGATION_OPENED is informational: it never changes a job status and never counts as arrival (spec 8.3);
 * nothing in this function touches a job.
 *
 * @throws ValidationError
 */
export async function recordLocationEventInTx(tx: TenantTx, input: RecordLocationEventInput, now: Date = new Date()): Promise<RecordedLocationEvent> {
  validate(input, now);
  const settings = await loadLocationSettings(tx, input.tenantId);
  const orgUnitId =
    input.orgUnitId !== undefined ? input.orgUnitId : ((await orgUnitAtInTx(tx, input.tenantId, input.employeeId, now))?.orgUnitId ?? null);
  const accuracyM = input.position ? Math.ceil(input.position.accuracyM) : null;

  const row = await tx.locationEvent.create({
    data: {
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      shiftId: input.shiftId,
      jobId: input.jobId,
      orgUnitId,
      kind: input.kind,
      source: input.source,
      verification: input.verification ?? "UNVERIFIED",
      latitude: input.position ? roundCoordinate(input.position.latitude) : null,
      longitude: input.position ? roundCoordinate(input.position.longitude) : null,
      accuracyM,
      distanceToJobM: input.distance ? Math.round(input.distance.distanceToJobM) : null,
      geofenceRadiusM: input.distance?.geofenceRadiusM ?? null,
      deviceTime: input.deviceTime ?? null,
      serverTime: now,
      deviceId: input.deviceId,
      exception: input.exception,
      exceptionNote: input.exceptionNote?.trim(),
      recordedByUserId: input.recordedByUserId,
      fieldEventId: input.fieldEventId,
    },
    select: { id: true, kind: true, source: true, accuracyM: true, deviceTime: true, serverTime: true, verification: true },
  });
  return {
    ...row,
    hasPosition: input.position !== undefined,
    usableAsEvidence: input.position !== undefined && isAccurateEnough(accuracyM, settings.locationMaxAccuracyM),
  };
}
