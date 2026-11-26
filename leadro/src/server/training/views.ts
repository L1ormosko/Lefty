import type { Prisma, TrainingAssignment, TrainingCourse, TrainingRecord } from "@prisma/client";
import { employeeScopeColumns, type AccessDecision, type ScopeColumns } from "@/server/authz";
import { ForbiddenError } from "@/server/core";

/**
 * API shapes of training records. Explicit mappers (not "return the row") so a column added later stays hidden until
 * someone decides it belongs in the API. Calendar dates are `YYYY-MM-DD`, timestamps ISO datetimes. Status values are
 * language-neutral codes; clients label them with `TRAINING.ASSIGNMENT_STATUS.*` / `TRAINING.RECORD_STATUS.*`.
 */

export const isoDateOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);
const instantOf = (value: Date | null): string | null => (value ? value.toISOString() : null);
/** A `YYYY-MM-DD` string as the value of a Postgres `date` column. */
export const dateColumn = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

export function toCourseView(row: TrainingCourse) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    description: row.description,
    certificationId: row.certificationId,
    validityDays: row.validityDays,
    active: row.active,
    archivedAt: instantOf(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type CourseView = ReturnType<typeof toCourseView>;

/** `today` = the tenant-local date; overdue = still open and due before today (derived, never stored). */
export function toAssignmentView(row: TrainingAssignment, today: string) {
  const dueDate = isoDateOf(row.dueDate);
  const open = row.status === "ASSIGNED" || row.status === "IN_PROGRESS";
  return {
    id: row.id,
    employeeId: row.employeeId,
    courseId: row.courseId,
    dueDate,
    status: row.status,
    overdue: open && dueDate !== null && dueDate < today,
    source: row.source,
    recommendationId: row.recommendationId,
    assignedById: row.assignedById,
    assignedAt: row.assignedAt.toISOString(),
    note: row.note,
    trainingRecordId: row.trainingRecordId,
    completedAt: instantOf(row.completedAt),
    cancelledAt: instantOf(row.cancelledAt),
    cancelledById: row.cancelledById,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type AssignmentView = ReturnType<typeof toAssignmentView>;

export function toRecordView(row: TrainingRecord) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    courseId: row.courseId,
    completedAt: row.completedAt.toISOString(),
    expiresAt: isoDateOf(row.expiresAt),
    status: row.status,
    evidence: {
      reference: row.evidenceReference,
      fileName: row.evidenceFileName,
      contentType: row.evidenceContentType,
      sizeBytes: row.evidenceSizeBytes,
      checksumSha256: row.evidenceChecksumSha256,
      /** Always false today: no StorageProvider is configured, so only the metadata exists (§28.3). */
      stored: row.evidenceStorageKey !== null,
    },
    notes: row.notes,
    recordedById: row.recordedById,
    recordedAt: row.recordedAt.toISOString(),
    verifiedById: row.verifiedById,
    verifiedAt: instantOf(row.verifiedAt),
    decisionReason: row.decisionReason,
    qualificationId: row.qualificationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type RecordView = ReturnType<typeof toRecordView>;

/**
 * Assignments and records belong to an employee, so their data scope is the EMPLOYEE's (placements, legal employer,
 * OWN): this wraps the employee scope columns in the `employee` relation.
 */
function viaEmployee<W extends object>(wrap: (employee: Prisma.EmployeeWhereInput) => W): ScopeColumns<W> {
  const { orgUnit, legalEntity, own } = employeeScopeColumns;
  return {
    orgUnit: orgUnit && ((ids, now) => wrap(orgUnit(ids, now))),
    legalEntity: legalEntity && ((ids, now) => wrap(legalEntity(ids, now))),
    own: own && ((employeeId, now) => wrap(own(employeeId, now))),
  };
}
export const assignmentScopeColumns = viaEmployee<Prisma.TrainingAssignmentWhereInput>((employee) => ({ employee }));
export const recordScopeColumns = viaEmployee<Prisma.TrainingRecordWhereInput>((employee) => ({ employee }));

/**
 * Training data has one field set (`base`). A grant limited to another set must not read or change it here.
 * @throws ForbiddenError
 */
export function assertBaseFields(decision: AccessDecision): void {
  if (!decision.fieldSets.includes("base")) throw new ForbiddenError();
}
