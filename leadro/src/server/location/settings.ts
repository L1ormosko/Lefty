import type { TenantTx } from "@/server/db";

/** The tenant's location knobs (`OperationsSettings`, ERD "Phase 3"). No settings row = the defaults of the schema. */
export interface LocationSettings {
  arrivalGeofenceRadiusM: number;
  /** A position with a larger accuracy radius than this never counts as evidence (spec 17.2, 26.5). */
  locationMaxAccuracyM: number;
  presenceMaxAgeMinutes: number;
  locationRetentionDays: number;
}

export const DEFAULT_LOCATION_SETTINGS: LocationSettings = {
  arrivalGeofenceRadiusM: 150,
  locationMaxAccuracyM: 100,
  presenceMaxAgeMinutes: 30,
  locationRetentionDays: 90,
};

export async function loadLocationSettings(tx: TenantTx, tenantId: string): Promise<LocationSettings> {
  const row = await tx.operationsSettings.findUnique({
    where: { tenantId },
    select: { arrivalGeofenceRadiusM: true, locationMaxAccuracyM: true, presenceMaxAgeMinutes: true, locationRetentionDays: true },
  });
  return row ?? DEFAULT_LOCATION_SETTINGS;
}
