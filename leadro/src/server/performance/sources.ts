import {
  documentationOpportunities,
  feedbackOpportunities,
  onTimeArrivalOpportunities,
  outcomeConversionOpportunities,
  recoveryConversionOpportunities,
  repeatVisitOpportunities,
  SALES_DECISION_OUTCOMES,
  trainingProgressOpportunities,
  type CompletedVisit,
  type MetricKind,
  type MetricParams,
  type Opportunity,
} from "@/lib/performance-formulas";
import type { TenantTx } from "@/server/db";

/**
 * Reads the records each metric kind is computed from, READ-ONLY and inside the caller's transaction (ARCHITECTURE.md
 * "Cross-module data access rule": read models only). Nothing here writes to another module's tables, and no other module
 * reads anything back from performance (spec 10.3; architecture test `tests/performance/architecture.test.ts`).
 * The formulas themselves are pure (`src/lib/performance-formulas.ts`).
 */

export interface SourceWindow {
  tenantId: string;
  employeeIds: string[];
  /** The period as UTC instants `[from, to)` (tenant-local days converted by the caller). */
  from: Date;
  to: Date;
  /** The period as `@db.Date` values (UTC midnight of the local dates), for date columns (training due dates). */
  fromDate: Date;
  toDate: Date;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const jobFactsSelect = { jobTypeId: true, jobType: { select: { category: true } } } as const;

/** Jobs completed in the window with the LEAD assignments of the computed employees (attribution is pure: `attributeVisit`). */
async function completedVisits(tx: TenantTx, window: SourceWindow) {
  const rows = await tx.job.findMany({
    where: {
      tenantId: window.tenantId,
      completedAt: { gte: window.from, lt: window.to },
      assignments: { some: { role: "LEAD", employeeId: { in: window.employeeIds } } },
    },
    select: {
      id: true,
      customerId: true,
      completedAt: true,
      currentVisitNumber: true,
      ...jobFactsSelect,
      assignments: { where: { role: "LEAD", employeeId: { in: window.employeeIds } }, select: { employeeId: true, assignedAt: true, endedAt: true } },
    },
  });
  return rows.map((row) => ({
    visit: {
      jobId: row.id,
      customerId: row.customerId,
      // completedAt is set by the filter above.
      completedAt: row.completedAt as Date,
      jobTypeId: row.jobTypeId,
      jobCategory: row.jobType.category,
      leadAssignments: row.assignments.flatMap((assignment) => (assignment.employeeId ? [{ employeeId: assignment.employeeId, assignedAt: assignment.assignedAt, endedAt: assignment.endedAt }] : [])),
    } satisfies CompletedVisit,
    currentVisitNumber: row.currentVisitNumber,
  }));
}

async function repeatVisits(tx: TenantTx, window: SourceWindow, windowDays: number): Promise<Opportunity[]> {
  const visits = (await completedVisits(tx, window)).map((row) => row.visit);
  if (visits.length === 0) return [];
  const customerIds = [...new Set(visits.map((visit) => visit.customerId))];
  // A cancelled job never happened for the customer, so it is not a repeat visit.
  const laterJobs = await tx.job.findMany({
    where: {
      tenantId: window.tenantId,
      customerId: { in: customerIds },
      status: { not: "CANCELLED" },
      createdAt: { gt: window.from, lte: new Date(window.to.getTime() + windowDays * DAY_MS) },
    },
    select: { id: true, customerId: true, jobTypeId: true, createdAt: true },
  });
  return repeatVisitOpportunities(
    visits,
    laterJobs.map((job) => ({ jobId: job.id, customerId: job.customerId, jobTypeId: job.jobTypeId, createdAt: job.createdAt })),
    windowDays,
    window.now,
  );
}

async function onTimeArrivals(tx: TenantTx, window: SourceWindow): Promise<Opportunity[]> {
  // Verified = recorded without exception (RECORDED) or verified by a manager; pending and rejected arrivals are not counted.
  const rows = await tx.arrivalVerification.findMany({
    where: {
      tenantId: window.tenantId,
      employeeId: { in: window.employeeIds },
      arrivedAt: { gte: window.from, lt: window.to },
      status: { in: ["RECORDED", "MANAGER_VERIFIED"] },
      job: { appointmentWindowEnd: { not: null } },
    },
    select: { id: true, employeeId: true, arrivedAt: true, job: { select: { appointmentWindowEnd: true, ...jobFactsSelect } } },
  });
  return onTimeArrivalOpportunities(
    rows.flatMap((row) =>
      row.job.appointmentWindowEnd
        ? [{ arrivalId: row.id, employeeId: row.employeeId, arrivedAt: row.arrivedAt, appointmentWindowEnd: row.job.appointmentWindowEnd, jobTypeId: row.job.jobTypeId, jobCategory: row.job.jobType.category }]
        : [],
    ),
  );
}

async function documentation(tx: TenantTx, window: SourceWindow): Promise<Opportunity[]> {
  const visits = await completedVisits(tx, window);
  if (visits.length === 0) return [];
  const jobTypeIds = [...new Set(visits.map((row) => row.visit.jobTypeId))];
  const categories = [...new Set(visits.map((row) => row.visit.jobCategory))];
  // A form is required for a visit when a version for its job type or category had been published before completion.
  const forms = await tx.jobCompletionFormDefinition.findMany({
    where: { tenantId: window.tenantId, publishedAt: { not: null, lt: window.to }, OR: [{ jobTypeId: { in: jobTypeIds } }, { category: { in: categories } }] },
    select: { jobTypeId: true, category: true, publishedAt: true },
  });
  const completions = await tx.jobCompletion.findMany({
    where: { tenantId: window.tenantId, jobId: { in: visits.map((row) => row.visit.jobId) } },
    select: { jobId: true, visitNumber: true },
  });
  const submitted = new Set(completions.map((completion) => `${completion.jobId}:${completion.visitNumber}`));
  return documentationOpportunities(
    visits.map(({ visit, currentVisitNumber }) => ({
      ...visit,
      formRequired: forms.some(
        (form) => (form.jobTypeId === visit.jobTypeId || form.category === visit.jobCategory) && form.publishedAt !== null && form.publishedAt.getTime() <= visit.completedAt.getTime(),
      ),
      completionSubmitted: submitted.has(`${visit.jobId}:${currentVisitNumber}`),
    })),
  );
}

async function outcomeConversion(tx: TenantTx, window: SourceWindow): Promise<Opportunity[]> {
  const rows = await tx.jobOutcome.findMany({
    where: { tenantId: window.tenantId, employeeId: { in: window.employeeIds }, occurredAt: { gte: window.from, lt: window.to }, outcome: { in: [...SALES_DECISION_OUTCOMES] } },
    select: { id: true, employeeId: true, outcome: true, job: { select: jobFactsSelect } },
  });
  return outcomeConversionOpportunities(
    rows.flatMap((row) => (row.employeeId ? [{ outcomeId: row.id, employeeId: row.employeeId, outcome: row.outcome, jobTypeId: row.job.jobTypeId, jobCategory: row.job.jobType.category }] : [])),
  );
}

async function recoveryConversion(tx: TenantTx, window: SourceWindow): Promise<Opportunity[]> {
  // Decided in the period: recovered (recoveredAt), or closed without recovery (closedAt). A RECOVERED case later CLOSED keeps
  // its recoveredAt, so it is counted once, at recovery.
  const inWindow = { gte: window.from, lt: window.to };
  const rows = await tx.leadRecoveryCase.findMany({
    where: {
      tenantId: window.tenantId,
      assignedToId: { in: window.employeeIds },
      status: { in: ["RECOVERED", "NOT_RECOVERED", "CLOSED"] },
      OR: [{ recoveredAt: inWindow }, { recoveredAt: null, closedAt: inWindow }],
    },
    select: { id: true, assignedToId: true, recoveredAt: true, job: { select: jobFactsSelect } },
  });
  return recoveryConversionOpportunities(
    rows.flatMap((row) => (row.assignedToId ? [{ caseId: row.id, employeeId: row.assignedToId, recovered: row.recoveredAt !== null, jobTypeId: row.job.jobTypeId, jobCategory: row.job.jobType.category }] : [])),
  );
}

async function feedbackAverage(tx: TenantTx, window: SourceWindow): Promise<Opportunity[]> {
  const rows = await tx.customerFeedback.findMany({
    where: { tenantId: window.tenantId, employeeId: { in: window.employeeIds }, rating: { not: null }, voidedAt: null, receivedAt: { gte: window.from, lt: window.to } },
    select: { id: true, employeeId: true, rating: true, job: { select: jobFactsSelect } },
  });
  return feedbackOpportunities(
    rows.flatMap((row) => (row.employeeId && row.rating !== null ? [{ feedbackId: row.id, employeeId: row.employeeId, rating: row.rating, jobTypeId: row.job.jobTypeId, jobCategory: row.job.jobType.category }] : [])),
  );
}

async function trainingProgress(tx: TenantTx, window: SourceWindow): Promise<Opportunity[]> {
  // Reads the training tables directly (read model; the training module owns every write to them).
  const rows = await tx.trainingAssignment.findMany({
    where: { tenantId: window.tenantId, employeeId: { in: window.employeeIds }, status: { not: "CANCELLED" }, dueDate: { gte: window.fromDate, lt: window.toDate } },
    select: { id: true, employeeId: true, status: true },
  });
  return trainingProgressOpportunities(rows.map((row) => ({ assignmentId: row.id, employeeId: row.employeeId, completed: row.status === "COMPLETED" })));
}

/** The opportunities of one kind for the window's employees and period. */
export async function readOpportunities(tx: TenantTx, kind: MetricKind, params: MetricParams, window: SourceWindow): Promise<Opportunity[]> {
  if (window.employeeIds.length === 0) return [];
  switch (kind) {
    case "REPEAT_VISIT_RATE":
      // windowDays is required for this kind (normalizeMetricParams); 30 is never reached for a stored version.
      return repeatVisits(tx, window, params.windowDays ?? 30);
    case "ON_TIME_ARRIVAL":
      return onTimeArrivals(tx, window);
    case "DOCUMENTATION_COMPLETENESS":
      return documentation(tx, window);
    case "OUTCOME_CONVERSION":
      return outcomeConversion(tx, window);
    case "RECOVERY_CONVERSION":
      return recoveryConversion(tx, window);
    case "CUSTOMER_FEEDBACK_AVERAGE":
      return feedbackAverage(tx, window);
    case "TRAINING_PROGRESS":
      return trainingProgress(tx, window);
  }
}
