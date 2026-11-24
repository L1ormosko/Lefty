import type { Prisma } from "@prisma/client";
import { baseFieldMap, type FieldMap } from "@/server/authz";

/**
 * Arrival fields returned by the API. An arrival holds distances, accuracy, codes and times, never coordinates
 * (those stay in `LocationEvent`), so every field is `base`. `confidence` is derived: wording is always about
 * confidence, never certainty (§17.2).
 */
export const ARRIVAL_FIELD_MAP: FieldMap = baseFieldMap([
  "id",
  "jobId",
  "employeeId",
  "shiftId",
  "method",
  "status",
  "arrivedAt",
  "recordedAt",
  "locationEventId",
  "accuracyM",
  "distanceToJobM",
  "geofenceRadiusM",
  "exceptionReason",
  "exceptionNote",
  "verifiedByUserId",
  "verifiedAt",
  "verificationNote",
  "confidence",
]);

export const arrivalSelect = {
  id: true,
  jobId: true,
  employeeId: true,
  shiftId: true,
  method: true,
  status: true,
  arrivedAt: true,
  recordedAt: true,
  locationEventId: true,
  accuracyM: true,
  distanceToJobM: true,
  geofenceRadiusM: true,
  exceptionReason: true,
  exceptionNote: true,
  verifiedByUserId: true,
  verifiedAt: true,
  verificationNote: true,
  locationEvent: { select: { verification: true } },
} satisfies Prisma.ArrivalVerificationSelect;
export type ArrivalRow = Prisma.ArrivalVerificationGetPayload<{ select: typeof arrivalSelect }>;

/** How much the server stands behind the arrival; a catalog key suffix (`ARRIVAL.CONFIDENCE.<code>`). */
export const ARRIVAL_CONFIDENCES = ["MANAGER_VERIFIED", "MANAGER_REJECTED", "WITHIN_RADIUS_REPORTED", "NEEDS_MANAGER_REVIEW", "TECHNICIAN_REPORTED"] as const;
export type ArrivalConfidence = (typeof ARRIVAL_CONFIDENCES)[number];

export function arrivalConfidence(row: Pick<ArrivalRow, "status" | "locationEvent">): ArrivalConfidence {
  if (row.status === "MANAGER_VERIFIED") return "MANAGER_VERIFIED";
  if (row.status === "MANAGER_REJECTED") return "MANAGER_REJECTED";
  if (row.status === "PENDING_MANAGER_REVIEW") return "NEEDS_MANAGER_REVIEW";
  return row.locationEvent?.verification === "WITHIN_RADIUS" ? "WITHIN_RADIUS_REPORTED" : "TECHNICIAN_REPORTED";
}

/** The row as the API's plain record (still unprojected: run it through `projectFields`). */
export function arrivalView(row: ArrivalRow): Record<string, unknown> {
  const { locationEvent, ...columns } = row;
  return { ...columns, confidence: arrivalConfidence({ status: row.status, locationEvent }) };
}
