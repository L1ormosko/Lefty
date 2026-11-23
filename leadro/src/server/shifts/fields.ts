import type { Prisma } from "@prisma/client";
import { baseFieldMap, type FieldMap, type ResourceRef, type RowScopeAttributes, type ScopeColumns } from "@/server/authz";

/**
 * Shift fields returned by the API. A shift holds no coordinates and no sensitive field set (the location events it
 * points at do), so every field is `base`. Anything not listed is dropped by projection: a new column must be
 * classified on purpose.
 */
export const SHIFT_FIELD_MAP: FieldMap = baseFieldMap([
  "id",
  "employeeId",
  "orgUnitId",
  "status",
  "startedAt",
  "startRecordedAt",
  "endedAt",
  "endRecordedAt",
  "deviceId",
  "startLocationEventId",
  "endLocationEventId",
  "startException",
  "startExceptionNote",
  "endException",
  "endExceptionNote",
  "endedByUserId",
  "endReason",
  "exceptionReviewStatus",
  "reviewedById",
  "reviewedAt",
  "reviewNote",
  "createdAt",
  "updatedAt",
]);

export const shiftSelect = {
  id: true,
  employeeId: true,
  orgUnitId: true,
  status: true,
  startedAt: true,
  startRecordedAt: true,
  endedAt: true,
  endRecordedAt: true,
  deviceId: true,
  startLocationEventId: true,
  endLocationEventId: true,
  startException: true,
  startExceptionNote: true,
  endException: true,
  endExceptionNote: true,
  endedByUserId: true,
  endReason: true,
  exceptionReviewStatus: true,
  reviewedById: true,
  reviewedAt: true,
  reviewNote: true,
  createdAt: true,
  updatedAt: true,
  /** Scope attributes: the employee's legal employer and user (self-approval check). */
  employee: { select: { legalEntityId: true, userId: true } },
} satisfies Prisma.ShiftSelect;

export type ShiftRow = Prisma.ShiftGetPayload<{ select: typeof shiftSelect }>;

/** The row as the API's plain record (still unprojected: run it through `projectFields`). */
export function shiftView(row: ShiftRow): Record<string, unknown> {
  const { employee: _employee, ...columns } = row;
  return columns;
}

/**
 * How data scopes apply to shifts (PERMISSIONS.md section 4): ORG_UNIT follows the placement SNAPSHOT taken when the
 * shift started (a later transfer does not move past shifts between managers), LEGAL_ENTITY the employee's legal
 * employer, OWN the technician's own shifts. ASSIGNED has no meaning for a shift.
 */
export const shiftScopeColumns: ScopeColumns<Prisma.ShiftWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ employee: { legalEntityId: { in: legalEntityIds } } }),
  own: (employeeId) => ({ employeeId }),
};

export const shiftAttributes = (row: Pick<ShiftRow, "orgUnitId" | "employeeId" | "employee">): RowScopeAttributes => ({
  orgUnitIds: row.orgUnitId ? [row.orgUnitId] : [],
  legalEntityIds: row.employee.legalEntityId ? [row.employee.legalEntityId] : [],
  ownerEmployeeId: row.employeeId,
});

/** The `ResourceRef` of a shift row, for `enforceInTx`. Built from the stored row, never from the request. */
export const shiftResourceRef = (row: Pick<ShiftRow, "orgUnitId" | "employeeId" | "employee">): ResourceRef => ({
  orgUnitId: row.orgUnitId ?? undefined,
  legalEntityId: row.employee.legalEntityId ?? undefined,
  ownerEmployeeId: row.employeeId,
});
