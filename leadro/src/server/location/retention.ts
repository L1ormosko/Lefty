import { recordAudit } from "@/server/audit";
import { withTenant } from "@/server/db";
import { loadLocationSettings } from "./settings";

export interface PurgeResult {
  /** Events whose coordinates were removed by this run. */
  purged: number;
  /** Events older than this instant lost their coordinates. */
  cutoff: Date;
}

/**
 * Retention (spec 22.2, ERD "Location data is sensitive"): removes the raw coordinates of location events older than
 * the tenant's `locationRetentionDays` and stamps `coordinatesPurgedAt`. The ROW STAYS: shifts, arrival verifications
 * and recovery cases reference it, and kind, times, accuracy, distance and verdict are the non-sensitive record they
 * need. Idempotent (already purged rows are skipped). Runs as the system: the audit event has no actor.
 *
 * Exported as a callable function only; there is no scheduler yet (a later hardening task wires one per tenant).
 */
export async function purgeExpiredCoordinates(tenantId: string, now: Date = new Date()): Promise<PurgeResult> {
  return withTenant(tenantId, async (tx) => {
    const { locationRetentionDays } = await loadLocationSettings(tx, tenantId);
    const cutoff = new Date(now.getTime() - locationRetentionDays * 86_400_000);
    const { count } = await tx.locationEvent.updateMany({
      where: { tenantId, serverTime: { lt: cutoff }, coordinatesPurgedAt: null, latitude: { not: null } },
      data: { latitude: null, longitude: null, coordinatesPurgedAt: now },
    });
    if (count > 0) {
      await recordAudit(tx, {
        tenantId,
        actorUserId: null,
        sourceApp: "SYSTEM",
        action: "location.purge_coordinates",
        targetType: "LocationEvent",
        newValue: { purged: count, retentionDays: locationRetentionDays, cutoff: cutoff.toISOString() },
      });
    }
    return { purged: count, cutoff };
  });
}
