import { haversineKm } from "@/lib/dispatch-scoring";
import { classifyPresence, type PresenceUnknownReason, type PresenceValue } from "@/lib/recovery-rules";
import type { TenantTx } from "@/server/db";
import { latestValidLocation, loadLocationSettings } from "@/server/location";

/**
 * The technician's presence at the customer's site when a case is evaluated (§9.4, §26.5). It is derived, never stored as a
 * position: the answer is AT_LOCATION / LEFT_LOCATION only when the technician's latest location event is fresh
 * (`presenceMaxAgeMinutes`) AND accurate (`locationMaxAccuracyM`) AND the site has coordinates; otherwise UNKNOWN with a
 * machine reason. Coordinates are read here and dropped here: only the status, the accuracy and the event id (the evidence
 * link, not exposed by the API) leave this function.
 */
export interface PresenceSnapshot {
  status: PresenceValue;
  reason: PresenceUnknownReason | null;
  locationEventId: string | null;
  accuracyM: number | null;
  distanceM: number | null;
  evaluatedAt: Date;
}

const UNKNOWN = (reason: PresenceUnknownReason, evaluatedAt: Date): PresenceSnapshot => ({ status: "UNKNOWN", reason, locationEventId: null, accuracyM: null, distanceM: null, evaluatedAt });

export async function evaluatePresence(tx: TenantTx, tenantId: string, input: { technicianId: string | null; jobId: string; now?: Date }): Promise<PresenceSnapshot> {
  const now = input.now ?? new Date();
  if (!input.technicianId) return UNKNOWN("no_location", now);
  const settings = await loadLocationSettings(tx, tenantId);

  const valid = await latestValidLocation(tx, input.technicianId, {
    tenantId,
    maxAgeMinutes: settings.presenceMaxAgeMinutes,
    maxAccuracyM: settings.locationMaxAccuracyM,
    now,
  });
  if (!valid) {
    // Say WHY it is unknown (no data at all, too old, too imprecise); only metadata is read.
    const latest = await tx.locationEvent.findFirst({
      where: { tenantId, employeeId: input.technicianId },
      orderBy: [{ serverTime: "desc" }, { id: "desc" }],
      select: { accuracyM: true, serverTime: true },
    });
    if (!latest) return UNKNOWN("no_location", now);
    const stale = now.getTime() - latest.serverTime.getTime() > settings.presenceMaxAgeMinutes * 60_000;
    if (stale) return UNKNOWN("stale_location", now);
    return UNKNOWN(latest.accuracyM !== null && latest.accuracyM > settings.locationMaxAccuracyM ? "inaccurate_location" : "no_coordinates", now);
  }

  const job = await tx.job.findFirst({
    where: { id: input.jobId, tenantId },
    select: { serviceAddress: { select: { latitude: true, longitude: true, geofenceRadiusM: true } } },
  });
  const address = job?.serviceAddress;
  const hasSite = address?.latitude != null && address?.longitude != null;
  const distanceM = hasSite
    ? Math.round(haversineKm({ latitude: valid.latitude, longitude: valid.longitude }, { latitude: Number(address.latitude), longitude: Number(address.longitude) }) * 1000)
    : null;
  const result = classifyPresence({
    hasValidLocation: true,
    distanceM,
    accuracyM: valid.accuracyM,
    radiusM: address?.geofenceRadiusM ?? settings.arrivalGeofenceRadiusM,
  });
  if (result.status === "UNKNOWN") return UNKNOWN(result.reason, now);
  return { status: result.status, reason: null, locationEventId: valid.locationEventId, accuracyM: valid.accuracyM, distanceM, evaluatedAt: now };
}
