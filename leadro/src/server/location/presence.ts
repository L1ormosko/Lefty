import type { LocationEventKind } from "@prisma/client";
import type { TenantTx } from "@/server/db";

export interface LatestValidLocationOptions {
  tenantId: string;
  /** Events older than this say nothing about where the employee is now (spec 26.5). Tenant setting `presenceMaxAgeMinutes`. */
  maxAgeMinutes: number;
  /** Positions with a larger accuracy radius are not evidence (spec 17.2). Tenant setting `locationMaxAccuracyM`. */
  maxAccuracyM: number;
  now?: Date;
  /** Only events recorded for this job count (a manager's refresh must not poll a technician's whereabouts in general). */
  jobId?: string;
}

/** A position the server may reason about. INTERNAL: carries coordinates, so it must never be returned by an API. */
export interface ValidLocation {
  locationEventId: string;
  kind: LocationEventKind;
  jobId: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  deviceTime: Date | null;
  serverTime: Date;
}

/**
 * The employee's most recent position that is BOTH fresh and accurate enough to act on, or null (spec 26.5: with no
 * valid recent data the answer is "unknown", never a guess). Used by arrival verification (Task 3) and recovery
 * presence (Task 6), which turn it into distances and statuses; only those derived values are ever shown.
 *
 * Purged positions (retention) have no coordinates and are skipped. Events are read by `serverTime`, the clock the
 * server trusts, not the device clock.
 */
export async function latestValidLocation(tx: TenantTx, employeeId: string, options: LatestValidLocationOptions): Promise<ValidLocation | null> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.maxAgeMinutes * 60_000);
  // §26.5: a position is "now" only if it was TAKEN recently. An offline fix captured days ago and synced just now has a
  // fresh serverTime but an old deviceTime, so both clocks must be inside the window (the older one decides).
  const row = await tx.locationEvent.findFirst({
    where: {
      tenantId: options.tenantId,
      employeeId,
      ...(options.jobId ? { jobId: options.jobId } : {}),
      latitude: { not: null },
      longitude: { not: null },
      accuracyM: { lte: options.maxAccuracyM },
      serverTime: { gte: cutoff, lte: now },
      OR: [{ deviceTime: null }, { deviceTime: { gte: cutoff } }],
    },
    orderBy: [{ serverTime: "desc" }, { id: "desc" }],
    select: { id: true, kind: true, jobId: true, latitude: true, longitude: true, accuracyM: true, deviceTime: true, serverTime: true },
  });
  if (!row || row.latitude === null || row.longitude === null || row.accuracyM === null) return null;
  return {
    locationEventId: row.id,
    kind: row.kind,
    jobId: row.jobId,
    latitude: row.latitude.toNumber(),
    longitude: row.longitude.toNumber(),
    accuracyM: row.accuracyM,
    deviceTime: row.deviceTime,
    serverTime: row.serverTime,
  };
}
