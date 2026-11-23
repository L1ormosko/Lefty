import { isAccurateEnough } from "@/lib/location-rules";

/**
 * Pure rules for starting and ending a shift (spec 8.1, 17.4). A shift boundary is either backed by a usable device
 * position or it is an EXCEPTION that a manager reviews (`shifts.approve`). GPS is never "proof": even a good
 * position only means the device said so, it is stored with its accuracy and judged by people when it matters.
 */

/**
 * A boundary reported this long after it happened (offline sync, a phone that was off) is an exception a manager reviews:
 * the shift's time then rests on the device clock alone. Named constant, 15 minutes; a future `OperationsSettings` field
 * (no schema change in this task).
 */
export const DELAYED_BOUNDARY_THRESHOLD_MS = 15 * 60_000;

export type CaptureException =
  | "GPS_DISABLED"
  | "PERMISSION_DENIED"
  | "POOR_SIGNAL"
  | "DEVICE_OFFLINE"
  | "OUTSIDE_GEOFENCE"
  | "DELAYED"
  | "OTHER";

export interface CaptureInput {
  /** Accuracy radius (meters) of the position the device sent, or undefined when it sent none. */
  accuracyM?: number;
  /** The reason the technician gave (GPS off, permission denied, offline ...), if any. */
  exception?: { code: CaptureException; note?: string };
  /** How long ago the boundary happened on the device when the server received it (server now minus `occurredAt`). */
  delayedByMs?: number;
  /** Tenant setting: positions vaguer than this never count (spec 17.2). */
  maxAccuracyM: number;
}

export interface CaptureAssessment {
  /** `DEVICE_GPS` when a position came with the event, else a manual entry. */
  source: "DEVICE_GPS" | "MANUAL";
  /** The exception to store (given by the technician, or `POOR_SIGNAL` raised because the position is too vague). Null = clean capture. */
  exception: { code: CaptureException; note: string | null } | null;
  /** A boundary with an exception waits for a manager's review. */
  reviewRequired: boolean;
}

/**
 * Judges one shift start / end capture. Returns null when the input carries neither a position nor a reason: the
 * caller refuses it ("send a position or say why there is none"), because an unexplained blank is not an event.
 */
export function assessCapture(input: CaptureInput): CaptureAssessment | null {
  const hasPosition = input.accuracyM !== undefined;
  if (!hasPosition && !input.exception) return null;

  const stated = input.exception ? { code: input.exception.code, note: input.exception.note?.trim() || null } : null;
  // A position too vague to be evidence is still recorded, but the boundary becomes an exception a person can look at.
  const tooVague = hasPosition && !isAccurateEnough(input.accuracyM, input.maxAccuracyM);
  const delayed = (input.delayedByMs ?? 0) > DELAYED_BOUNDARY_THRESHOLD_MS;
  // A stated reason wins; else the server names what it can see: a vague fix, then a late report.
  const exception = stated ?? (tooVague ? { code: "POOR_SIGNAL" as const, note: null } : delayed ? { code: "DELAYED" as const, note: null } : null);
  return { source: hasPosition ? "DEVICE_GPS" : "MANUAL", exception, reviewRequired: exception !== null };
}

/**
 * The review state of a shift after a boundary was recorded. A new exception (re)opens the review; a clean boundary
 * leaves whatever decision exists untouched (an approved start exception stays approved when the end is clean).
 */
export function reviewStateAfterBoundary(
  current: "PENDING" | "APPROVED" | "REJECTED" | null,
  boundaryHasException: boolean,
): "PENDING" | "APPROVED" | "REJECTED" | null {
  return boundaryHasException ? "PENDING" : current;
}
