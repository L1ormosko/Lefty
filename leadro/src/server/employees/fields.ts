import type { Prisma } from "@prisma/client";
import { EMPLOYEE_FIELD_MAP, employeeRowAttributes, employeeScopeSelect, type FieldMap } from "@/server/authz";

/**
 * Employee fields returned by the API. `EMPLOYEE_FIELD_MAP` (authz) classifies every stored column;
 * `currentOrgUnitIds` is a derived, non-sensitive field (where the employee is placed right now),
 * so it is classified here. Anything not in the map is dropped by projection, so a new column
 * stays hidden until someone classifies it on purpose.
 */
export const EMPLOYEE_API_FIELD_MAP: FieldMap = { ...EMPLOYEE_FIELD_MAP, currentOrgUnitIds: "base" };

/** Stored columns that are returned (subject to projection). */
export const EMPLOYEE_COLUMNS = {
  id: true,
  userId: true,
  legalEntityId: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  jobTitle: true,
  status: true,
  hireDate: true,
  terminationDate: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EmployeeSelect;

/** Columns plus the active placements that scope matching and `currentOrgUnitIds` need. */
export const employeeSelect = (now: Date) =>
  ({ ...EMPLOYEE_COLUMNS, ...employeeScopeSelect(now) }) satisfies Prisma.EmployeeSelect;

export type EmployeeRow = Prisma.EmployeeGetPayload<{ select: ReturnType<typeof employeeSelect> }>;

/** A fetched row with its derived field, ready for `projectFields` / `projectRows`. */
export function withDerivedFields(row: EmployeeRow) {
  return { ...row, currentOrgUnitIds: row.assignments.map((placement) => placement.orgUnitId) };
}

export { employeeRowAttributes };
