import type { Prisma } from "@prisma/client";
import { activePlacementWhere } from "./time-windows";
import type { RowScopeAttributes, ScopeColumns } from "./scope-filter";

/**
 * Employees: org scope follows the employee's ACTIVE placements as of now (any one in scope is
 * enough); LEGAL_ENTITY follows the legal employer; OWN is the employee's own row. ASSIGNED has
 * no meaning for employee records.
 */
export const employeeScopeColumns: ScopeColumns<Prisma.EmployeeWhereInput> = {
  orgUnit: (orgUnitIds, now) => ({
    assignments: { some: { orgUnitId: { in: orgUnitIds }, ...activePlacementWhere(now) } },
  }),
  legalEntity: (legalEntityIds) => ({ legalEntityId: { in: legalEntityIds } }),
  own: (employeeId) => ({ id: employeeId }),
};

/**
 * Select fragment the scope attributes of an employee row need: merge it into the query's `select`
 * (or `include`) when you plan to `projectRows` the result.
 */
export const employeeScopeSelect = (now: Date = new Date()) =>
  ({
    id: true,
    legalEntityId: true,
    assignments: { where: activePlacementWhere(now), select: { orgUnitId: true } },
  }) satisfies Prisma.EmployeeSelect;

/** Row attributes for `projectRows`, from a row fetched with `employeeScopeSelect`. */
export function employeeRowAttributes(row: {
  id: string;
  legalEntityId: string | null;
  assignments: Array<{ orgUnitId: string }>;
}): RowScopeAttributes {
  return {
    orgUnitIds: row.assignments.map((placement) => placement.orgUnitId),
    legalEntityIds: row.legalEntityId ? [row.legalEntityId] : [],
    ownerEmployeeId: row.id,
  };
}

/** Org units themselves: in scope when the unit is one of the expanded (active) units. */
export const orgUnitScopeColumns: ScopeColumns<Prisma.OrgUnitWhereInput> = {
  orgUnit: (orgUnitIds) => ({ id: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ legalEntityId: { in: legalEntityIds } }),
};
