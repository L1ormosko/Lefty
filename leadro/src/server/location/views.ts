import type { Prisma } from "@prisma/client";
import type { ScopeColumns, RowScopeAttributes } from "@/server/authz";

/**
 * Location events as the API shows them. `LOCATION_EVENT_FIELD_MAP` (authz) classifies every field: everything is
 * `base` (when, kind, source, accuracy, verdict, distance) EXCEPT `latitude` / `longitude`, which only a grant naming
 * the opt-in `coordinates` set (`location.coordinate_fields`) reveals. Projection is per row, so a manager scoped to
 * one unit sees accuracy and verdicts of their people and never a position.
 */

export const locationEventSelect = {
  id: true,
  employeeId: true,
  shiftId: true,
  jobId: true,
  orgUnitId: true,
  kind: true,
  source: true,
  verification: true,
  latitude: true,
  longitude: true,
  accuracyM: true,
  distanceToJobM: true,
  geofenceRadiusM: true,
  deviceTime: true,
  serverTime: true,
  deviceId: true,
  exception: true,
  exceptionNote: true,
  coordinatesPurgedAt: true,
  recordedByUserId: true,
  fieldEventId: true,
  employee: { select: { legalEntityId: true } },
} satisfies Prisma.LocationEventSelect;

export type LocationEventRow = Prisma.LocationEventGetPayload<{ select: typeof locationEventSelect }>;

/** The row as plain JSON values (coordinates as numbers). Still UNPROJECTED: always pass it through `projectFields`. */
export function locationEventView(row: LocationEventRow): Record<string, unknown> {
  const { employee: _employee, latitude, longitude, ...rest } = row;
  return { ...rest, latitude: latitude?.toNumber() ?? null, longitude: longitude?.toNumber() ?? null };
}

/** Scope: ORG_UNIT / LEGAL_ENTITY follow the placement snapshot and the employee's legal employer; OWN is the technician's own events. */
export const locationEventScopeColumns: ScopeColumns<Prisma.LocationEventWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ employee: { legalEntityId: { in: legalEntityIds } } }),
  own: (employeeId) => ({ employeeId }),
};

export const locationEventAttributes = (row: Pick<LocationEventRow, "orgUnitId" | "employeeId" | "employee">): RowScopeAttributes => ({
  orgUnitIds: row.orgUnitId ? [row.orgUnitId] : [],
  legalEntityIds: row.employee.legalEntityId ? [row.employee.legalEntityId] : [],
  ownerEmployeeId: row.employeeId,
});
