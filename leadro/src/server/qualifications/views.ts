import type { Availability, Certification, EmployeeJobPermission, EmployeeQualification, ServiceTerritory, Skill } from "@prisma/client";
import { employeeScopeColumns, type AccessDecision, type ScopeColumns } from "@/server/authz";
import { ForbiddenError } from "@/server/core";
import type { Prisma } from "@prisma/client";

/**
 * API shapes of the qualification records. Explicit mappers (not "return the row") so a column
 * added later stays hidden until someone decides it belongs in the API. Calendar dates are
 * `YYYY-MM-DD`; timestamps are ISO datetimes (docs/API_CONVENTIONS.md). No performance data exists
 * on any of these records (§10.3).
 */

const dateOnly = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);
const instantOf = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toSkillView(row: Skill) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    description: row.description,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCertificationView(row: Certification) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    issuingAuthority: row.issuingAuthority,
    validityMonths: row.validityMonths,
    requiresNumber: row.requiresNumber,
    description: row.description,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Licence and certificate numbers identify a person to an issuing authority and can be abused, so they
 * are shown in full only to the holder and to approvers (HR). Everyone else with `qualifications.view`
 * sees the last four characters, which is enough to tell two records apart.
 */
export function maskCredentialNumber(number: string | null): string | null {
  if (number === null) return null;
  return number.length > 4 ? `\u2022\u2022\u2022\u2022${number.slice(-4)}` : "\u2022\u2022\u2022\u2022";
}

export function toQualificationView(row: EmployeeQualification, revealPrivate: boolean) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind,
    skillId: row.skillId,
    certificationId: row.certificationId,
    level: row.level,
    number: revealPrivate ? row.number : maskCredentialNumber(row.number),
    issuingAuthority: row.issuingAuthority,
    issuedAt: dateOnly(row.issuedAt),
    expiresAt: dateOnly(row.expiresAt),
    status: row.status,
    verifiedById: row.verifiedById,
    verifiedAt: instantOf(row.verifiedAt),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type QualificationView = ReturnType<typeof toQualificationView>;

export function toTerritoryView(row: ServiceTerritory) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    orgUnitId: row.orgUnitId,
    includeDescendants: row.includeDescendants,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: instantOf(row.effectiveTo),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toJobPermissionView(row: EmployeeJobPermission) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    jobTypeId: row.jobTypeId,
    category: row.category,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: instantOf(row.effectiveTo),
    grantedById: row.grantedById,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `note` (why someone is away) is shown only to the holder and approvers, like credential numbers. */
export function toAvailabilityView(row: Availability, revealPrivate: boolean) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind,
    timeZone: row.timeZone,
    isoDayOfWeek: row.isoDayOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    validFrom: dateOnly(row.validFrom),
    validTo: dateOnly(row.validTo),
    startsAt: instantOf(row.startsAt),
    endsAt: instantOf(row.endsAt),
    note: revealPrivate ? row.note : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Qualification records belong to an employee, so their data scope is the EMPLOYEE's (placements,
 * legal employer, OWN): this wraps the employee scope columns in the `employee` relation.
 */
function viaEmployee<W extends object>(columns: ScopeColumns<Prisma.EmployeeWhereInput>, wrap: (employee: Prisma.EmployeeWhereInput) => W): ScopeColumns<W> {
  const { orgUnit, legalEntity, own } = columns;
  return {
    orgUnit: orgUnit && ((ids, now) => wrap(orgUnit(ids, now))),
    legalEntity: legalEntity && ((ids, now) => wrap(legalEntity(ids, now))),
    own: own && ((employeeId, now) => wrap(own(employeeId, now))),
  };
}

export const qualificationScopeColumns = viaEmployee<Prisma.EmployeeQualificationWhereInput>(employeeScopeColumns, (employee) => ({ employee }));
export const territoryScopeColumns = viaEmployee<Prisma.ServiceTerritoryWhereInput>(employeeScopeColumns, (employee) => ({ employee }));
export const jobPermissionScopeColumns = viaEmployee<Prisma.EmployeeJobPermissionWhereInput>(employeeScopeColumns, (employee) => ({ employee }));
export const availabilityScopeColumns = viaEmployee<Prisma.AvailabilityWhereInput>(employeeScopeColumns, (employee) => ({ employee }));

/**
 * Qualification data has one field set (`base`). A grant limited to another set (say `availability`
 * on a dispatcher view) must not read or change it through these services.
 */
export function assertBaseFields(decision: AccessDecision): void {
  if (!decision.fieldSets.includes("base")) throw new ForbiddenError();
}
