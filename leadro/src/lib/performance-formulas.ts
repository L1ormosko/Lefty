/**
 * The fixed catalog of performance metric kinds (spec 10.2) and their formulas. Pure: no database, no framework.
 *
 * Every kind turns real records into OPPORTUNITIES (the denominator) for one employee and one job type / job category;
 * an opportunity contributes 0 or 1 to the numerator (a rate) or, for CUSTOMER_FEEDBACK_AVERAGE, its 1-5 rating (a sum).
 * There are no weights, no targets and no thresholds that trigger anything, and nothing here combines two kinds: a value
 * is always one dimension (spec 10.4 "no universal score"). The exact definitions are documented in
 * docs/DECISIONS.md "Phase 5 Task 3"; the server module (`src/server/performance/sources.ts`) only reads the records.
 */

export const METRIC_KINDS = [
  "REPEAT_VISIT_RATE",
  "ON_TIME_ARRIVAL",
  "DOCUMENTATION_COMPLETENESS",
  "OUTCOME_CONVERSION",
  "RECOVERY_CONVERSION",
  "CUSTOMER_FEEDBACK_AVERAGE",
  "TRAINING_PROGRESS",
] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export type MetricDimension = "REPEAT_VISITS" | "TIMELINESS" | "DOCUMENTATION" | "SALES" | "CUSTOMER_FEEDBACK" | "TRAINING_PROGRESS";

/** How a job-based value is broken down (TRAINING_PROGRESS is not job-based and has no breakdown). */
export const METRIC_BREAKDOWNS = ["JOB_TYPE", "JOB_CATEGORY"] as const;
export type MetricBreakdown = (typeof METRIC_BREAKDOWNS)[number];

/** The table whose ids a value's `evidenceIds` hold, per kind (ERD.md "Contracts for JSON, arrays and the metric kinds"). */
export type EvidenceTable = "Job" | "ArrivalVerification" | "JobOutcome" | "LeadRecoveryCase" | "CustomerFeedback" | "TrainingAssignment";

export interface MetricKindSpec {
  kind: MetricKind;
  /** Fixed by the kind (the database CHECK `performance_metric_definition_kind_dimension` says the same). */
  dimension: MetricDimension;
  evidenceTable: EvidenceTable;
  /** False only for TRAINING_PROGRESS. */
  jobBased: boolean;
  /** "rate": numerator counts opportunities that succeeded; "rating_sum": numerator is the sum of 1-5 ratings. */
  numeratorKind: "rate" | "rating_sum";
  /** The kind-specific `params` keys besides `breakdown` (documented, validated by `normalizeMetricParams`). */
  paramKeys: readonly string[];
}

export const METRIC_KIND_CATALOG: Readonly<Record<MetricKind, MetricKindSpec>> = {
  REPEAT_VISIT_RATE: { kind: "REPEAT_VISIT_RATE", dimension: "REPEAT_VISITS", evidenceTable: "Job", jobBased: true, numeratorKind: "rate", paramKeys: ["windowDays"] },
  ON_TIME_ARRIVAL: { kind: "ON_TIME_ARRIVAL", dimension: "TIMELINESS", evidenceTable: "ArrivalVerification", jobBased: true, numeratorKind: "rate", paramKeys: [] },
  DOCUMENTATION_COMPLETENESS: { kind: "DOCUMENTATION_COMPLETENESS", dimension: "DOCUMENTATION", evidenceTable: "Job", jobBased: true, numeratorKind: "rate", paramKeys: [] },
  OUTCOME_CONVERSION: { kind: "OUTCOME_CONVERSION", dimension: "SALES", evidenceTable: "JobOutcome", jobBased: true, numeratorKind: "rate", paramKeys: [] },
  RECOVERY_CONVERSION: { kind: "RECOVERY_CONVERSION", dimension: "SALES", evidenceTable: "LeadRecoveryCase", jobBased: true, numeratorKind: "rate", paramKeys: [] },
  CUSTOMER_FEEDBACK_AVERAGE: { kind: "CUSTOMER_FEEDBACK_AVERAGE", dimension: "CUSTOMER_FEEDBACK", evidenceTable: "CustomerFeedback", jobBased: true, numeratorKind: "rating_sum", paramKeys: [] },
  TRAINING_PROGRESS: { kind: "TRAINING_PROGRESS", dimension: "TRAINING_PROGRESS", evidenceTable: "TrainingAssignment", jobBased: false, numeratorKind: "rate", paramKeys: [] },
};

export const isMetricKind = (value: string): value is MetricKind => (METRIC_KINDS as readonly string[]).includes(value);

/** Normalized parameters of a definition version. `breakdown` is null exactly for TRAINING_PROGRESS. */
export interface MetricParams {
  breakdown: MetricBreakdown | null;
  /** REPEAT_VISIT_RATE only: a later job for the same customer and job type within this many days counts as a repeat. */
  windowDays?: number;
}

export const MAX_REPEAT_WINDOW_DAYS = 365;

/**
 * Checks and normalizes a definition's `params` for its kind. Unknown keys are refused (no hidden weights or thresholds can
 * be smuggled in); `breakdown` defaults to JOB_TYPE for job-based kinds.
 * @returns the normalized params, or a list of problems (`path` is the params key).
 */
export function normalizeMetricParams(kind: MetricKind, raw: Record<string, unknown>): { ok: true; params: MetricParams } | { ok: false; problems: Array<{ path: string; message: string }> } {
  const spec = METRIC_KIND_CATALOG[kind];
  const allowed = new Set([...(spec.jobBased ? ["breakdown"] : []), ...spec.paramKeys]);
  const problems: Array<{ path: string; message: string }> = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) problems.push({ path: key, message: `"${key}" is not a parameter of ${kind}` });
  }

  let breakdown: MetricBreakdown | null = null;
  if (spec.jobBased) {
    const value = raw.breakdown ?? "JOB_TYPE";
    if (typeof value === "string" && (METRIC_BREAKDOWNS as readonly string[]).includes(value)) breakdown = value as MetricBreakdown;
    else problems.push({ path: "breakdown", message: "breakdown must be JOB_TYPE or JOB_CATEGORY" });
  }

  const params: MetricParams = { breakdown };
  if (kind === "REPEAT_VISIT_RATE") {
    const windowDays = raw.windowDays;
    if (typeof windowDays === "number" && Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= MAX_REPEAT_WINDOW_DAYS) {
      params.windowDays = windowDays;
    } else {
      problems.push({ path: "windowDays", message: `windowDays must be a whole number of days from 1 to ${MAX_REPEAT_WINDOW_DAYS}` });
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, params };
}

// ───────── Opportunities and aggregation ─────────

/** What every job-based record knows about the job it belongs to. */
export interface JobFacts {
  jobTypeId: string;
  jobCategory: string;
}

/** One counted opportunity: the record (evidence), whose it is, its breakdown and what it adds to the numerator. */
export interface Opportunity extends Partial<JobFacts> {
  employeeId: string;
  evidenceId: string;
  /** 0 or 1 for a rate; the 1-5 rating for CUSTOMER_FEEDBACK_AVERAGE. */
  contribution: number;
}

/** One computed value: one employee x one breakdown (or none) for one definition and period. */
export interface AggregatedValue {
  employeeId: string;
  jobTypeId: string | null;
  jobCategory: string | null;
  numerator: number;
  /** The opportunities; also the sample size. */
  denominator: number;
  sampleSize: number;
  enoughData: boolean;
  /** Ids of the counted records, sorted (deterministic output for the same input). */
  evidenceIds: string[];
}

/**
 * Groups opportunities per employee and breakdown. `employeesWithoutData` (TRAINING_PROGRESS) get a value with sample 0
 * even when they have no opportunity, so "not enough data" is explicit; job-based kinds only produce values for breakdowns
 * that had at least one opportunity (there is no meaningful list of "all job types" to report zero for).
 */
export function aggregateOpportunities(
  opportunities: readonly Opportunity[],
  breakdown: MetricBreakdown | null,
  minSample: number,
  employeesWithoutData: readonly string[] = [],
): AggregatedValue[] {
  const groups = new Map<string, AggregatedValue>();
  const keyOf = (employeeId: string, jobTypeId: string | null, jobCategory: string | null) => JSON.stringify([employeeId, jobTypeId, jobCategory]);
  const group = (employeeId: string, jobTypeId: string | null, jobCategory: string | null): AggregatedValue => {
    const key = keyOf(employeeId, jobTypeId, jobCategory);
    let value = groups.get(key);
    if (!value) {
      value = { employeeId, jobTypeId, jobCategory, numerator: 0, denominator: 0, sampleSize: 0, enoughData: false, evidenceIds: [] };
      groups.set(key, value);
    }
    return value;
  };

  for (const employeeId of employeesWithoutData) group(employeeId, null, null);
  for (const opportunity of opportunities) {
    const jobTypeId = breakdown === "JOB_TYPE" ? (opportunity.jobTypeId ?? null) : null;
    const jobCategory = breakdown === "JOB_CATEGORY" ? (opportunity.jobCategory ?? null) : null;
    // A job-based opportunity without its breakdown attribute cannot be placed: skip it rather than invent a bucket.
    if (breakdown === "JOB_TYPE" && !jobTypeId) continue;
    if (breakdown === "JOB_CATEGORY" && !jobCategory?.trim()) continue;
    const value = group(opportunity.employeeId, jobTypeId, jobCategory);
    value.numerator += opportunity.contribution;
    value.denominator += 1;
    value.evidenceIds.push(opportunity.evidenceId);
  }

  return [...groups.values()]
    .map((value) => {
      const evidenceIds = [...new Set(value.evidenceIds)].sort();
      return { ...value, sampleSize: value.denominator, enoughData: value.denominator >= minSample, evidenceIds };
    })
    .sort((a, b) => keyOf(a.employeeId, a.jobTypeId, a.jobCategory).localeCompare(keyOf(b.employeeId, b.jobTypeId, b.jobCategory)));
}

// ───────── Per-kind classification (records -> opportunities) ─────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** A completed visit (a job whose `completedAt` falls in the period) and who led it. */
export interface CompletedVisit extends JobFacts {
  jobId: string;
  customerId: string;
  completedAt: Date;
  /** The job's LEAD assignments of the employees being computed (any state). */
  leadAssignments: ReadonlyArray<{ employeeId: string; assignedAt: Date; endedAt: Date | null }>;
}

/**
 * The employee a visit is attributed to: the LEAD assignment in effect when the job was completed (assigned at or before,
 * not ended before). With several (data repaired by hand), the latest assigned wins. Null = none of the computed employees.
 */
export function attributeVisit(visit: Pick<CompletedVisit, "completedAt" | "leadAssignments">): string | null {
  const at = visit.completedAt.getTime();
  const covering = visit.leadAssignments
    .filter((assignment) => assignment.assignedAt.getTime() <= at && (assignment.endedAt === null || assignment.endedAt.getTime() >= at))
    .sort((a, b) => b.assignedAt.getTime() - a.assignedAt.getTime());
  return covering[0]?.employeeId ?? null;
}

/** A later job that could make a visit a repeat. */
export interface LaterJob {
  jobId: string;
  customerId: string;
  jobTypeId: string;
  createdAt: Date;
}

/**
 * REPEAT_VISIT_RATE. Opportunity = a completed visit whose window has fully elapsed at `now` (completedAt + windowDays <= now),
 * so a value never counts a visit as "not repeated" before it could have been. Numerator = the visit was followed by another
 * (not cancelled) job for the same customer and job type, created after completion and within `windowDays`.
 */
export function repeatVisitOpportunities(visits: readonly CompletedVisit[], laterJobs: readonly LaterJob[], windowDays: number, now: Date): Opportunity[] {
  const windowMs = windowDays * DAY_MS;
  const result: Opportunity[] = [];
  for (const visit of visits) {
    const employeeId = attributeVisit(visit);
    if (!employeeId) continue;
    const completed = visit.completedAt.getTime();
    if (completed + windowMs > now.getTime()) continue;
    const repeated = laterJobs.some(
      (job) =>
        job.jobId !== visit.jobId &&
        job.customerId === visit.customerId &&
        job.jobTypeId === visit.jobTypeId &&
        job.createdAt.getTime() > completed &&
        job.createdAt.getTime() <= completed + windowMs,
    );
    result.push({ employeeId, evidenceId: visit.jobId, jobTypeId: visit.jobTypeId, jobCategory: visit.jobCategory, contribution: repeated ? 1 : 0 });
  }
  return result;
}

/** A verified arrival at a job with an appointment window. */
export interface WindowedArrival extends JobFacts {
  arrivalId: string;
  employeeId: string;
  arrivedAt: Date;
  appointmentWindowEnd: Date;
}

/**
 * ON_TIME_ARRIVAL. Opportunity = a verified arrival (recorded without exception, or verified by a manager) at a job with an
 * appointment window. Numerator = arrived no later than the window's end (arriving early is not late: the dimension is
 * timeliness towards the customer).
 */
export function onTimeArrivalOpportunities(arrivals: readonly WindowedArrival[]): Opportunity[] {
  return arrivals.map((arrival) => ({
    employeeId: arrival.employeeId,
    evidenceId: arrival.arrivalId,
    jobTypeId: arrival.jobTypeId,
    jobCategory: arrival.jobCategory,
    contribution: arrival.arrivedAt.getTime() <= arrival.appointmentWindowEnd.getTime() ? 1 : 0,
  }));
}

/** A completed visit with what documentation it needed and got. */
export interface DocumentedVisit extends CompletedVisit {
  /** A completion form for the job's type or category had been published before the job was completed. */
  formRequired: boolean;
  /** A completion was submitted for the job's (last) visit. */
  completionSubmitted: boolean;
}

/**
 * DOCUMENTATION_COMPLETENESS. Opportunity = a completed visit whose job type (or category) required a completion form at
 * completion time. Numerator = the visit's completion form was submitted (a submission is only accepted with every required
 * field, so "submitted" means "complete").
 */
export function documentationOpportunities(visits: readonly DocumentedVisit[]): Opportunity[] {
  const result: Opportunity[] = [];
  for (const visit of visits) {
    if (!visit.formRequired) continue;
    const employeeId = attributeVisit(visit);
    if (!employeeId) continue;
    result.push({ employeeId, evidenceId: visit.jobId, jobTypeId: visit.jobTypeId, jobCategory: visit.jobCategory, contribution: visit.completionSubmitted ? 1 : 0 });
  }
  return result;
}

/** Outcomes that are a sales decision (the customer was met and decided). */
export const SALES_DECISION_OUTCOMES = ["SOLD", "NOT_SOLD"] as const;

export interface ReportedOutcome extends JobFacts {
  outcomeId: string;
  employeeId: string;
  outcome: string;
}

/**
 * OUTCOME_CONVERSION. Opportunity = a visit outcome the employee reported that is a sales decision (SOLD or NOT_SOLD; customer
 * unavailable, reschedule, work not possible and pending approval are not opportunities). Numerator = SOLD.
 */
export function outcomeConversionOpportunities(outcomes: readonly ReportedOutcome[]): Opportunity[] {
  return outcomes
    .filter((row) => (SALES_DECISION_OUTCOMES as readonly string[]).includes(row.outcome))
    .map((row) => ({ employeeId: row.employeeId, evidenceId: row.outcomeId, jobTypeId: row.jobTypeId, jobCategory: row.jobCategory, contribution: row.outcome === "SOLD" ? 1 : 0 }));
}

export interface DecidedRecoveryCase extends JobFacts {
  caseId: string;
  /** The recovery employee the case is assigned to. */
  employeeId: string;
  recovered: boolean;
}

/** RECOVERY_CONVERSION. Opportunity = a recovery case assigned to the employee that was decided in the period. Numerator = recovered. */
export function recoveryConversionOpportunities(cases: readonly DecidedRecoveryCase[]): Opportunity[] {
  return cases.map((row) => ({ employeeId: row.employeeId, evidenceId: row.caseId, jobTypeId: row.jobTypeId, jobCategory: row.jobCategory, contribution: row.recovered ? 1 : 0 }));
}

export interface RatedFeedback extends JobFacts {
  feedbackId: string;
  employeeId: string;
  rating: number;
}

/**
 * CUSTOMER_FEEDBACK_AVERAGE. Opportunity = a rated, non-voided feedback about the employee. Numerator = the sum of the ratings
 * (the average is numerator / denominator; no float is stored). Ratings outside 1-5 are ignored (the table refuses them).
 */
export function feedbackOpportunities(feedback: readonly RatedFeedback[]): Opportunity[] {
  return feedback
    .filter((row) => Number.isInteger(row.rating) && row.rating >= 1 && row.rating <= 5)
    .map((row) => ({ employeeId: row.employeeId, evidenceId: row.feedbackId, jobTypeId: row.jobTypeId, jobCategory: row.jobCategory, contribution: row.rating }));
}

export interface DueAssignment {
  assignmentId: string;
  employeeId: string;
  completed: boolean;
}

/** TRAINING_PROGRESS. Opportunity = a non-cancelled training assignment due in the period. Numerator = completed (at computation time). */
export function trainingProgressOpportunities(assignments: readonly DueAssignment[]): Opportunity[] {
  return assignments.map((row) => ({ employeeId: row.employeeId, evidenceId: row.assignmentId, contribution: row.completed ? 1 : 0 }));
}

// ───────── Periods ─────────

export const MAX_PERIOD_DAYS = 366;

/** Whole days between two `YYYY-MM-DD` dates (end exclusive). */
export function periodLengthDays(periodStart: string, periodEnd: string): number {
  return Math.round((Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / DAY_MS);
}
