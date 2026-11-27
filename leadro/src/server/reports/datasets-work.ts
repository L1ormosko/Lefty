import {
  FollowUpOrigin,
  FollowUpStatus,
  FollowUpTargetType,
  JobOrigin,
  JobOutcomeType,
  JobStatus,
  PaymentMethod,
  PaymentStatus,
  TrainingRecordStatus,
  WorkPriority,
  type Prisma,
} from "@prisma/client";
import { JOB_FIELD_MAP, JOB_OUTCOME_FIELD_MAP } from "@/server/authz";
import { jobScopeColumns } from "@/server/customers";
import { resolveFollowUpListAccess } from "@/server/follow-ups";
import { trainingRecordScopeColumns } from "@/server/training";
import { columnsFrom, unitRowScope, unitScopeSelect, viaRelation, type ReportDataset, type ReportWhere } from "./dataset-types";

/**
 * Operational datasets: jobs, visit outcomes, follow-up tasks, training records. Field sets come from the owners' field
 * maps (`JOB_FIELD_MAP`, `JOB_OUTCOME_FIELD_MAP`); follow-ups and training have none (the whole record is `base`).
 */

const values = (enumObject: Record<string, string>) => Object.values(enumObject);
const DEFAULT_EXPORT_ROWS = 10_000;

const jobColumn = columnsFrom(JOB_FIELD_MAP);
/** Jobs attribute to the service-area unit snapshotted on the job (global constraint "Attribution"). */
const jobUnitColumns = { orgUnit: jobScopeColumns.orgUnit, legalEntity: jobScopeColumns.legalEntity } as ReportDataset["scopeColumns"];

export const jobsDataset: ReportDataset = {
  key: "jobs",
  viewPermission: "jobs.view",
  exportPermission: "jobs.export",
  scopeColumns: jobUnitColumns,
  orgUnitFilter: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  dateColumn: "createdAt",
  defaultSort: { column: "createdAt", direction: "desc" },
  maxExportRows: DEFAULT_EXPORT_ROWS,
  columns: [
    jobColumn("id", "id"),
    jobColumn("number", "integer", { sortable: true }),
    jobColumn("status", "enum", { enumValues: values(JobStatus), filter: "in" }),
    jobColumn("priority", "enum", { enumValues: values(WorkPriority), filter: "in" }),
    jobColumn("origin", "enum", { enumValues: values(JobOrigin), filter: "in" }),
    jobColumn("title", "text"),
    jobColumn("customerId", "id", { filter: "in" }),
    jobColumn("jobTypeId", "id", { filter: "in" }),
    jobColumn("orgUnitId", "id"),
    jobColumn("leadId", "id"),
    jobColumn("scheduledStartAt", "instant", { sortable: true }),
    jobColumn("scheduledEndAt", "instant"),
    jobColumn("completedAt", "instant", { sortable: true }),
    jobColumn("cancelledAt", "instant"),
    jobColumn("estimatedDurationMinutes", "integer"),
    jobColumn("quotedAmountMinor", "money", { currencyColumn: "currency" }),
    jobColumn("currency", "currency", { filter: "in" }),
    jobColumn("createdAt", "instant", { sortable: true }),
    jobColumn("archivedAt", "instant"),
  ],
  scopeSelect: unitScopeSelect(),
  rowScope: unitRowScope(),
  findMany: (tx, args) => tx.job.findMany(args as Prisma.JobFindManyArgs),
  count: (tx, where) => tx.job.count({ where: where as Prisma.JobWhereInput }),
};

const outcomeColumn = columnsFrom(JOB_OUTCOME_FIELD_MAP);

/** Outcomes have no unit of their own: they attribute to their job's unit (as `listJobOutcomes` does). */
export const jobOutcomesDataset: ReportDataset = {
  key: "job_outcomes",
  viewPermission: "job_outcomes.view",
  exportPermission: "jobs.export",
  scopeColumns: viaRelation("job", jobUnitColumns),
  orgUnitFilter: (orgUnitIds) => ({ job: { orgUnitId: { in: orgUnitIds } } }),
  dateColumn: "occurredAt",
  defaultSort: { column: "occurredAt", direction: "desc" },
  maxExportRows: DEFAULT_EXPORT_ROWS,
  columns: [
    outcomeColumn("id", "id"),
    outcomeColumn("jobId", "id", { filter: "in" }),
    outcomeColumn("visitNumber", "integer"),
    outcomeColumn("employeeId", "id", { filter: "in" }),
    outcomeColumn("outcome", "enum", { enumValues: values(JobOutcomeType), filter: "in" }),
    outcomeColumn("lostReasonId", "id", { filter: "in" }),
    outcomeColumn("quotedAmountMinor", "money", { currencyColumn: "currency" }),
    outcomeColumn("approvedAmountMinor", "money", { currencyColumn: "currency" }),
    outcomeColumn("chargedAmountMinor", "money", { currencyColumn: "currency" }),
    outcomeColumn("collectedAmountMinor", "money", { currencyColumn: "currency" }),
    outcomeColumn("currency", "currency", { filter: "in" }),
    outcomeColumn("paymentMethod", "enum", { enumValues: values(PaymentMethod) }),
    outcomeColumn("paymentStatus", "enum", { enumValues: values(PaymentStatus), filter: "in" }),
    outcomeColumn("customerRequestedFollowUp", "boolean", { filter: "boolean" }),
    outcomeColumn("occurredAt", "instant", { sortable: true }),
    outcomeColumn("recordedAt", "instant", { sortable: true }),
  ],
  scopeSelect: unitScopeSelect("job"),
  rowScope: unitRowScope("job"),
  findMany: (tx, args) => tx.jobOutcome.findMany(args as Prisma.JobOutcomeFindManyArgs),
  count: (tx, where) => tx.jobOutcome.count({ where: where as Prisma.JobOutcomeWhereInput }),
};

const followUpColumn = columnsFrom(null);

/** Follow-ups: the unit copied from the target (as in follow-ups/access.ts), plus that module's target gate. */
export const followUpTasksDataset: ReportDataset = {
  key: "follow_up_tasks",
  viewPermission: "follow_ups.view",
  exportPermission: "leads.export",
  scopeColumns: {
    orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
    legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
  },
  orgUnitFilter: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  // A task never reveals a record its reader cannot reach: the owner's gate (scope AND viewable target) holds on every row.
  accessGate: async (tx, actor, now) => (await resolveFollowUpListAccess(tx, actor, "follow_ups.view", now)).where as ReportWhere,
  dateColumn: "dueAt",
  defaultSort: { column: "dueAt", direction: "asc" },
  maxExportRows: DEFAULT_EXPORT_ROWS,
  columns: [
    followUpColumn("id", "id"),
    followUpColumn("targetType", "enum", { enumValues: values(FollowUpTargetType), filter: "in" }),
    followUpColumn("leadId", "id"),
    followUpColumn("customerId", "id"),
    followUpColumn("jobId", "id"),
    followUpColumn("recoveryCaseId", "id"),
    followUpColumn("orgUnitId", "id"),
    followUpColumn("title", "text"),
    followUpColumn("status", "enum", { enumValues: values(FollowUpStatus), filter: "in" }),
    followUpColumn("priority", "enum", { enumValues: values(WorkPriority), filter: "in" }),
    followUpColumn("origin", "enum", { enumValues: values(FollowUpOrigin), filter: "in" }),
    followUpColumn("assigneeId", "id", { filter: "in" }),
    followUpColumn("dueAt", "instant", { sortable: true }),
    followUpColumn("completedAt", "instant", { sortable: true }),
    followUpColumn("cancelledAt", "instant"),
    followUpColumn("createdAt", "instant", { sortable: true }),
  ],
  findMany: (tx, args) => tx.followUpTask.findMany(args as Prisma.FollowUpTaskFindManyArgs),
  count: (tx, where) => tx.followUpTask.count({ where: where as Prisma.FollowUpTaskWhereInput }),
};

const trainingColumn = columnsFrom(null);
const { orgUnit: trainingOrgUnit, legalEntity: trainingLegalEntity } = trainingRecordScopeColumns;

/**
 * Training records belong to an employee: the scope is the employee's (current placement, legal employer), exactly as
 * the training module's own list (`trainingRecordScopeColumns`). The org unit filter follows the same placement.
 */
export const trainingRecordsDataset: ReportDataset = {
  key: "training_records",
  viewPermission: "training.view",
  exportPermission: "employees.export",
  scopeColumns: { orgUnit: trainingOrgUnit, legalEntity: trainingLegalEntity } as ReportDataset["scopeColumns"],
  orgUnitFilter: (orgUnitIds) => (trainingOrgUnit ? (trainingOrgUnit(orgUnitIds, new Date()) as ReportWhere) : { id: { in: [] } }),
  dateColumn: "completedAt",
  defaultSort: { column: "completedAt", direction: "desc" },
  maxExportRows: DEFAULT_EXPORT_ROWS,
  columns: [
    trainingColumn("id", "id"),
    trainingColumn("employeeId", "id", { filter: "in" }),
    trainingColumn("courseId", "id", { filter: "in" }),
    trainingColumn("status", "enum", { enumValues: values(TrainingRecordStatus), filter: "in" }),
    trainingColumn("completedAt", "instant", { sortable: true }),
    trainingColumn("expiresAt", "date", { sortable: true }),
    trainingColumn("recordedAt", "instant", { sortable: true }),
    trainingColumn("verifiedAt", "instant"),
    trainingColumn("qualificationId", "id"),
  ],
  findMany: (tx, args) => tx.trainingRecord.findMany(args as Prisma.TrainingRecordFindManyArgs),
  count: (tx, where) => tx.trainingRecord.count({ where: where as Prisma.TrainingRecordWhereInput }),
};
