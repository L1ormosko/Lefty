import type { Prisma } from "@prisma/client";
import { baseFieldMap, type FieldMap } from "@/server/authz";
import { isRecoveryStatus, nextRecoveryStatuses } from "@/lib/recovery-lifecycle";

/**
 * Fields the recovery API returns. Recovery data has no sensitive field set of its own: visibility is decided by the row
 * (`recovery.*` scope). Presence appears ONLY as `presenceStatus` + age/accuracy/reason; the location event id and the
 * distance are internal and never leave (coordinates and location history are a separate, sensitive permission, §22.2).
 * Anything not listed is dropped by projection (fail closed).
 */
export const CASE_FIELD_MAP: FieldMap = baseFieldMap([
  "id",
  "number",
  "jobOutcomeId",
  "jobId",
  "customerId",
  "leadId",
  "technicianId",
  "orgUnitId",
  "lostReasonId",
  "status",
  "statusChangedAt",
  "priority",
  "priorityScore",
  "assignedToId",
  "assignedAt",
  "ruleId",
  "ruleVersion",
  "recommendation",
  "outcomeAt",
  "presenceStatus",
  "presenceEvaluatedAt",
  "presenceAccuracyM",
  "presenceReason",
  "presenceAgeMinutes",
  "initialValueMinor",
  "estimatedValueMinor",
  "currency",
  "recoveredAt",
  "recoveredAmountMinor",
  "collectedAmountMinor",
  "recoveredJobId",
  "recoveredLeadId",
  "recoveredById",
  "attemptCount",
  "lastAttemptAt",
  "closedAt",
  "closeReason",
  "createdAt",
  "updatedAt",
  "number",
  "nextStatuses",
  "revenue",
]);

export const CASE_COLUMNS = {
  id: true,
  number: true,
  jobOutcomeId: true,
  jobId: true,
  customerId: true,
  leadId: true,
  technicianId: true,
  orgUnitId: true,
  lostReasonId: true,
  status: true,
  statusChangedAt: true,
  priority: true,
  priorityScore: true,
  assignedToId: true,
  assignedAt: true,
  ruleId: true,
  ruleVersion: true,
  recommendation: true,
  outcomeAt: true,
  presenceStatus: true,
  presenceEvaluatedAt: true,
  presenceAccuracyM: true,
  presenceReason: true,
  initialValueMinor: true,
  estimatedValueMinor: true,
  currency: true,
  recoveredAt: true,
  recoveredAmountMinor: true,
  collectedAmountMinor: true,
  recoveredJobId: true,
  recoveredLeadId: true,
  recoveredById: true,
  attemptCount: true,
  lastAttemptAt: true,
  closedAt: true,
  closeReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LeadRecoveryCaseSelect;

/** Columns plus what scope matching needs. */
export const caseRowSelect = {
  ...CASE_COLUMNS,
  orgUnit: { select: { legalEntityId: true } },
} satisfies Prisma.LeadRecoveryCaseSelect;
export type CaseRow = Prisma.LeadRecoveryCaseGetPayload<{ select: typeof caseRowSelect }>;

/**
 * The record as the API shows it. `revenue` keeps the two kinds of money apart (§9.7): `confirmed` are facts that were
 * recorded with `recoveredAt`; `estimated` is a guess and is never added to the confirmed figures.
 */
export function caseView(row: CaseRow, now: Date = new Date()): Record<string, unknown> {
  const { orgUnit: _orgUnit, ...columns } = row;
  const age = row.presenceEvaluatedAt ? Math.max(0, Math.round((now.getTime() - row.presenceEvaluatedAt.getTime()) / 60_000)) : null;
  return {
    ...columns,
    presenceAgeMinutes: age,
    nextStatuses: isRecoveryStatus(row.status) ? nextRecoveryStatuses(row.status) : [],
    revenue: {
      currency: row.currency,
      confirmed: row.recoveredAt ? { recoveredAmountMinor: row.recoveredAmountMinor, collectedAmountMinor: row.collectedAmountMinor, recoveredAt: row.recoveredAt } : null,
      estimated: { estimatedValueMinor: row.estimatedValueMinor, initialValueMinor: row.initialValueMinor },
    },
  };
}

export const RULE_FIELD_MAP: FieldMap = baseFieldMap([
  "id",
  "ruleKey",
  "version",
  "name",
  "description",
  "status",
  "priority",
  "trigger",
  "conditions",
  "actions",
  "orgUnitId",
  "highImpact",
  "cooldownMinutes",
  "createdById",
  "submittedAt",
  "approvedById",
  "approvedAt",
  "activatedAt",
  "createdAt",
  "updatedAt",
  "needsApproval",
]);

export const ruleRowSelect = {
  id: true,
  ruleKey: true,
  version: true,
  name: true,
  description: true,
  status: true,
  priority: true,
  trigger: true,
  conditions: true,
  actions: true,
  orgUnitId: true,
  highImpact: true,
  cooldownMinutes: true,
  createdById: true,
  submittedAt: true,
  approvedById: true,
  approvedAt: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
  orgUnit: { select: { legalEntityId: true } },
} satisfies Prisma.RecoveryRuleSelect;
export type RuleRow = Prisma.RecoveryRuleGetPayload<{ select: typeof ruleRowSelect }>;

export function ruleView(row: RuleRow): Record<string, unknown> {
  const { orgUnit: _orgUnit, ...columns } = row;
  // A high-impact rule can only become ACTIVE through approval by someone other than its author.
  return { ...columns, needsApproval: row.highImpact && row.status !== "ACTIVE" };
}

export const ATTEMPT_FIELD_MAP: FieldMap = baseFieldMap([
  "id",
  "caseId",
  "employeeId",
  "channel",
  "outcome",
  "occurredAt",
  "durationSeconds",
  "notes",
  "offeredAmountMinor",
  "recordedAt",
  "recordedById",
]);

export const attemptSelect = {
  id: true,
  caseId: true,
  employeeId: true,
  channel: true,
  outcome: true,
  occurredAt: true,
  durationSeconds: true,
  notes: true,
  offeredAmountMinor: true,
  recordedAt: true,
  recordedById: true,
} satisfies Prisma.RecoveryAttemptSelect;
