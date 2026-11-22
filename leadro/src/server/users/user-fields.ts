import type { Prisma } from "@prisma/client";
import { activePlacementWhere, baseFieldMap, type RowScopeAttributes, type ScopeColumns } from "@/server/authz";

/**
 * What the users API may return. Deliberately NOT included (so they can never leak, even if a
 * query selects them by mistake): passwordHash, mfaSecretEncrypted, mfaLastUsedStep,
 * failedLoginCount, lockedUntil. Projection drops every unlisted column.
 */
export const USER_FIELD_MAP = baseFieldMap([
  "id",
  "email",
  "status",
  "locale",
  "timeZone",
  "mfaEnabled",
  "lastLoginAt",
  "employeeId",
  "employeeStatus",
  "loginPendingDeactivation",
  "firstName",
  "lastName",
  "createdAt",
  "updatedAt",
]);

/**
 * A terminated employee has no open placement, so the org-unit scope below no longer reaches their
 * user: such users (above all those whose login is `loginPendingDeactivation`) are visible only to
 * tenant-wide user administrators, who are also the only ones who can deactivate them. Decided in
 * Task 5 fix round 2 (the alternative, keeping them visible through their last unit, would need
 * history-based scopes in authz).
 *
 * A user's place in the org tree is that of their employee record: org-unit scopes follow the
 * employee's active placements, legal-entity scopes their legal employer, OWN their own employee.
 * A user with no employee record (e.g. the company Owner) belongs to no unit, so only a TENANT scope
 * reaches them. This mirrors how `can` resolves a user target (`employeeId` or `{}`), so the list
 * and the single-record check always agree.
 */
export const userInOrgUnits = (orgUnitIds: string[], at: Date): Prisma.UserWhereInput => ({
  employee: { assignments: { some: { orgUnitId: { in: orgUnitIds }, ...activePlacementWhere(at) } } },
});
export const userInLegalEntities = (legalEntityIds: string[]): Prisma.UserWhereInput => ({
  employee: { legalEntityId: { in: legalEntityIds } },
});
export const userOfEmployee = (employeeId: string): Prisma.UserWhereInput => ({ employee: { id: employeeId } });

export const userScopeColumns: ScopeColumns<Prisma.UserWhereInput> = {
  orgUnit: userInOrgUnits,
  legalEntity: userInLegalEntities,
  own: userOfEmployee,
};

/** The employee relation a user row needs for scope matching and the name fields. */
export const userEmployeeSelect = (at: Date) =>
  ({
    id: true,
    firstName: true,
    lastName: true,
    status: true,
    legalEntityId: true,
    assignments: { where: activePlacementWhere(at), select: { orgUnitId: true } },
  }) satisfies Prisma.EmployeeSelect;

export const userSelect = (at: Date) =>
  ({
    id: true,
    email: true,
    status: true,
    locale: true,
    timeZone: true,
    mfaEnabled: true,
    lastLoginAt: true,
    createdAt: true,
    updatedAt: true,
    employee: { select: userEmployeeSelect(at) },
  }) satisfies Prisma.UserSelect;

export type UserRow = Prisma.UserGetPayload<{ select: ReturnType<typeof userSelect> }>;

/** Flattens a fetched user for projection; scope attributes ride along and are dropped (unmapped). */
export function flattenUser(row: UserRow) {
  const { employee, ...user } = row;
  return {
    ...user,
    employeeId: employee?.id ?? null,
    employeeStatus: employee?.status ?? null,
    // Employment ended but the login is still usable: a user administrator must deactivate it.
    loginPendingDeactivation: employee?.status === "TERMINATED" && user.status === "ACTIVE",
    firstName: employee?.firstName ?? null,
    lastName: employee?.lastName ?? null,
    // not in USER_FIELD_MAP, so removed by projection; kept for `userRowAttributes`
    orgUnitIds: employee?.assignments.map((placement) => placement.orgUnitId) ?? [],
    legalEntityId: employee?.legalEntityId ?? null,
  };
}

/** Scope attributes of a flattened user (see `flattenUser`). */
export function userRowAttributes(row: ReturnType<typeof flattenUser>): RowScopeAttributes {
  return {
    orgUnitIds: row.orgUnitIds,
    legalEntityIds: row.legalEntityId ? [row.legalEntityId] : [],
    ownerEmployeeId: row.employeeId,
  };
}
