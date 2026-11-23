import type { Prisma } from "@prisma/client";
import { baseFieldMap, type FieldMap } from "@/server/authz";
import { isFollowUpOverdue, isFollowUpStatus, nextFollowUpStatuses } from "@/lib/follow-up-lifecycle";

/**
 * Follow-up fields returned by the API. Follow-ups have no sensitive field set: every column is `base`, so visibility
 * is decided by the row (follow-up scope AND access to the target), never by field. `overdue` and `nextStatuses` are
 * derived. Anything not in the map is dropped by projection (fail closed); the sweep stamps and `tenantId` never leave.
 */
export const FOLLOW_UP_FIELD_MAP: FieldMap = baseFieldMap([
  "id",
  "targetType",
  "leadId",
  "customerId",
  "jobId",
  "recoveryCaseId",
  "orgUnitId",
  "title",
  "description",
  "status",
  "priority",
  "origin",
  "assigneeId",
  "assignedAt",
  "dueAt",
  "completedAt",
  "completedById",
  "completionNote",
  "cancelledAt",
  "cancelReason",
  "createdById",
  "createdAt",
  "updatedAt",
  "overdue",
  "nextStatuses",
]);

/** Stored columns that are returned (subject to projection). */
export const FOLLOW_UP_COLUMNS = {
  id: true,
  targetType: true,
  leadId: true,
  customerId: true,
  jobId: true,
  recoveryCaseId: true,
  orgUnitId: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  origin: true,
  assigneeId: true,
  assignedAt: true,
  dueAt: true,
  completedAt: true,
  completedById: true,
  completionNote: true,
  cancelledAt: true,
  cancelReason: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FollowUpTaskSelect;

/** Columns plus what scope matching needs: the unit's legal entity and the creator's employee record (OWN scope). */
export const followUpRowSelect = {
  ...FOLLOW_UP_COLUMNS,
  orgUnit: { select: { legalEntityId: true } },
  createdBy: { select: { employee: { select: { id: true } } } },
} satisfies Prisma.FollowUpTaskSelect;

export type FollowUpRow = Prisma.FollowUpTaskGetPayload<{ select: typeof followUpRowSelect }>;

/** The id of whichever target column is set. */
export function targetIdOf(row: Pick<FollowUpRow, "targetType" | "leadId" | "customerId" | "jobId" | "recoveryCaseId">): string {
  const id = { LEAD: row.leadId, CUSTOMER: row.customerId, JOB: row.jobId, RECOVERY_CASE: row.recoveryCaseId }[row.targetType];
  // The table CHECK guarantees exactly the matching column is set.
  if (!id) throw new Error(`Follow-up of type ${row.targetType} has no target id`);
  return id;
}

/** The record as the API shows it before projection: the columns plus `overdue` and the statuses it can move to. */
export function followUpView(row: FollowUpRow, now: Date = new Date()): Record<string, unknown> {
  const { orgUnit: _orgUnit, createdBy: _createdBy, ...columns } = row;
  const status = isFollowUpStatus(row.status) ? row.status : null;
  return {
    ...columns,
    overdue: status ? isFollowUpOverdue(status, row.dueAt, now) : false,
    nextStatuses: status ? nextFollowUpStatuses(status) : [],
  };
}
