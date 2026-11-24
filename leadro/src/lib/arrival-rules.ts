import { haversineKm } from "@/lib/dispatch-scoring";
import { isAccurateEnough } from "@/lib/location-rules";

/**
 * Pure arrival rules (§8.4, §17.2, §17.4). A reported position is judged against the job address:
 * straight-line distance (never a travel time) against a radius. The result is a CANDIDATE verification,
 * never proof of presence; anything the server cannot confirm needs a manager (`PENDING_MANAGER_REVIEW`).
 */

export interface ArrivalJudgementInput {
  /** The device position with its accuracy radius, or null when there is none (GPS off, offline...). */
  position: { latitude: number; longitude: number; accuracyM: number } | null;
  /** The job address; null coordinates when it was never geocoded. */
  address: { latitude: number | null; longitude: number | null };
  radiusM: number;
  maxAccuracyM: number;
}

/** Why the server could not confirm the arrival itself (the exception a manager reviews). */
export type ArrivalReviewReason = "NO_POSITION" | "ADDRESS_WITHOUT_COORDINATES" | "POOR_ACCURACY" | "OUTSIDE_RADIUS";

export interface ArrivalJudgement {
  /** Straight-line meters from the device position to the address (rounded), when both are known. */
  distanceM: number | null;
  /** WITHIN_RADIUS: a candidate verification; OUTSIDE_RADIUS: measured outside; UNVERIFIED: not measurable. */
  verification: "WITHIN_RADIUS" | "OUTSIDE_RADIUS" | "UNVERIFIED";
  /** Null when the server found the position consistent with the address; else why a manager must look. */
  reviewReason: ArrivalReviewReason | null;
}

export function judgeArrival(input: ArrivalJudgementInput): ArrivalJudgement {
  const { position, address } = input;
  if (!position) return { distanceM: null, verification: "UNVERIFIED", reviewReason: "NO_POSITION" };
  if (address.latitude === null || address.longitude === null) return { distanceM: null, verification: "UNVERIFIED", reviewReason: "ADDRESS_WITHOUT_COORDINATES" };
  const distanceM = Math.round(haversineKm(position, { latitude: address.latitude, longitude: address.longitude }) * 1000);
  // A vague fix proves nothing either way (it is recorded with its accuracy, §17.2).
  if (!isAccurateEnough(position.accuracyM, input.maxAccuracyM)) return { distanceM, verification: "UNVERIFIED", reviewReason: "POOR_ACCURACY" };
  if (distanceM <= input.radiusM) return { distanceM, verification: "WITHIN_RADIUS", reviewReason: null };
  return { distanceM, verification: "OUTSIDE_RADIUS", reviewReason: "OUTSIDE_RADIUS" };
}

/** The `LocationException` stored for a review reason. */
export function exceptionForReviewReason(reason: ArrivalReviewReason): "DEVICE_OFFLINE" | "OUTSIDE_GEOFENCE" | "POOR_SIGNAL" | "OTHER" {
  if (reason === "OUTSIDE_RADIUS") return "OUTSIDE_GEOFENCE";
  if (reason === "POOR_ACCURACY") return "POOR_SIGNAL";
  if (reason === "NO_POSITION") return "DEVICE_OFFLINE";
  return "OTHER";
}
