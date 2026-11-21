import type { Prisma } from "@prisma/client";
import { activePlacementWhere } from "./resolve-resource";
import type { ScopeColumns } from "./scope-filter";

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

/** Org units themselves: in scope when the unit is one of the expanded (active) units. */
export const orgUnitScopeColumns: ScopeColumns<Prisma.OrgUnitWhereInput> = {
  orgUnit: (orgUnitIds) => ({ id: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ legalEntityId: { in: legalEntityIds } }),
};
