/**
 * The ONE KPI catalog (spec 13.4). Every KPI any dashboard or report shows is an entry here, referenced by its key only. A key
 * never means two things: a variant (another anchor, another population) is another key with its own label.
 *
 * Pure data, no Prisma, no Next. The analytics module (`src/server/analytics`) computes the ACTIVE entries; permissions named
 * here are catalog keys of `src/server/authz/permission-catalog.ts` (checked by `tests/analytics/kpi-catalog.test.ts`).
 * `docs/KPI_DEFINITIONS.md` is generated from this file (`npm run kpi:docs`); a drift test keeps the two equal.
 */

/** The dashboard family a KPI is defined for (where it lives in the docs). Any dashboard may show it if the viewer qualifies. */
export const KPI_FAMILIES = ["OPERATIONAL", "LEAD", "FINANCIAL", "EXECUTIVE"] as const;
export type KpiFamily = (typeof KPI_FAMILIES)[number];

/**
 * - COUNT: number of records.
 * - RATE: share of a population (numerator / denominator, 0..1); both parts are returned.
 * - DURATION: median elapsed time in seconds over the sample.
 * - MONEY: sum of integer minor units, one figure PER CURRENCY (never summed across currencies).
 * - RATIO: records per distinct contributor (e.g. completed jobs per employee); numerator and denominator are returned.
 * - PER_HOUR: records per hour of a measured time base (e.g. completed jobs per recorded shift hour); numerator (records) and
 *   denominator (hours) are returned.
 */
export const KPI_UNITS = ["COUNT", "RATE", "DURATION", "MONEY", "RATIO", "PER_HOUR"] as const;
export type KpiUnit = (typeof KPI_UNITS)[number];

/** BLOCKED_ON_SPEC: the spec does not define the inputs yet (spec 28.4); the engine returns that status, never a value. */
export const KPI_STATUSES = ["ACTIVE", "BLOCKED_ON_SPEC"] as const;
export type KpiStatus = (typeof KPI_STATUSES)[number];

/**
 * How the requested date range selects records:
 * - EVENT_IN_PERIOD: records whose `anchor` event happened in the range (completions by completion time).
 * - COHORT_IN_PERIOD: records CREATED in the range, measured as they are now (a cohort's rate can still change later).
 * - SNAPSHOT: the state right now; the date range and period grouping do not apply.
 */
export const KPI_PERIOD_SEMANTICS = ["EVENT_IN_PERIOD", "COHORT_IN_PERIOD", "SNAPSHOT"] as const;
export type KpiPeriodSemantics = (typeof KPI_PERIOD_SEMANTICS)[number];

/** Org levels a KPI can be grouped by (via the org unit tree); TENANT = one figure for the whole scope. */
export const KPI_ORG_LEVELS = ["TENANT", "STATE", "REGION", "CITY", "BRANCH"] as const;
export type KpiOrgLevel = (typeof KPI_ORG_LEVELS)[number];

/** A fixed extra breakdown of every value row. CURRENCY is implied for MONEY. */
export type KpiBreakdown = "LEAD_SOURCE";

/** Record set the Dispatcher's `analytics_operational.view { set: "dispatch_kpis" }` grant covers (Phase 6 Task 1 contract). */
export const DISPATCH_KPI_SET = "dispatch_kpis";

export interface KpiAccess {
  /** Any ONE of these permissions qualifies; the viewer's scope is the union of the qualifying grants' scopes. */
  permissions: readonly string[];
  /** The field set the qualifying grant must reveal (`base` = the non-sensitive fields). */
  fieldSet: string;
  /** Record sets the KPI belongs to, passed as satisfied sets so set-qualified grants (`dispatch_kpis`) can cover it. */
  sets: readonly string[];
}

export interface KpiDefinition {
  key: string;
  family: KpiFamily;
  status: KpiStatus;
  unit: KpiUnit;
  /** i18n key of the display name (`KPI.<KEY>`). */
  labelKey: string;
  definition: string;
  formula: string;
  sourceRecords: readonly string[];
  period: { semantics: KpiPeriodSemantics; anchor: string };
  /** Org levels it may be grouped by; TENANT (no grouping) is always allowed. */
  orgLevels: readonly KpiOrgLevel[];
  /** Which org unit (and for employee KPIs which assignment) a record counts for (spec 3). */
  attribution: string;
  /** Role template key responsible for the data behind the KPI (configurable per tenant later). */
  dataOwnerRole: string;
  access: KpiAccess;
  breakdown?: KpiBreakdown;
  /** True when the figure is an estimate and must be labelled as such (spec 9.7). */
  estimate?: boolean;
  /** Why the KPI cannot be computed (BLOCKED_ON_SPEC only). */
  blockedReason?: string;
}

const ALL_LEVELS: readonly KpiOrgLevel[] = KPI_ORG_LEVELS;
const label = (key: string) => `KPI.${key.toUpperCase()}`;

const OPERATIONAL = { permissions: ["analytics_operational.view"], fieldSet: "base", sets: [] } as const;
const DISPATCH = { permissions: ["analytics_operational.view"], fieldSet: "base", sets: [DISPATCH_KPI_SET] } as const;
/** Lead results also appear on the executive dashboard (spec 13.1 "Conversion rate", "Lead source performance", "Recovery outcomes"). */
const LEAD = { permissions: ["analytics_lead.view", "analytics_executive.view"], fieldSet: "base", sets: [] } as const;
/** Money KPIs (Task 3): the finance permission over the scope (spec 4.5 "Financial reports"); Task 3 may tighten the field set. */
const FINANCIAL = { permissions: ["financial_reports.view"], fieldSet: "base", sets: [] } as const;
const EXECUTIVE = { permissions: ["analytics_executive.view", "analytics_operational.view"], fieldSet: "base", sets: [] } as const;

const JOB_ATTRIBUTION = "The org unit snapshotted on the job (Job.orgUnitId).";
const LEAD_ATTRIBUTION = "The org unit snapshotted on the lead (Lead.orgUnitId); leads without one count only in tenant-wide figures.";
const CASE_ATTRIBUTION = "The org unit snapshotted on the recovery case (LeadRecoveryCase.orgUnitId).";
const LEDGER_ATTRIBUTION = "The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).";
const TASK3 = "Computed by Phase 6 Task 3.";

function kpi(entry: Omit<KpiDefinition, "labelKey" | "status"> & { status?: KpiStatus }): KpiDefinition {
  return { status: "ACTIVE", labelKey: label(entry.key), ...entry };
}

export const KPI_CATALOG: readonly KpiDefinition[] = [
  // ── Operational (spec 13.2) ──
  kpi({
    key: "lead_response_time",
    family: "OPERATIONAL",
    unit: "DURATION",
    definition: "How long a new lead waits for the first outbound contact attempt.",
    formula: "median(first CONTACT_ATTEMPT interaction.occurredAt - Lead.createdAt) over leads created in the period that have a contact attempt; DUPLICATE leads excluded.",
    sourceRecords: ["Lead", "LeadInteraction"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Lead.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: LEAD_ATTRIBUTION,
    dataOwnerRole: "LEAD_OPERATIONS_MANAGER",
    access: { permissions: ["analytics_operational.view", "analytics_lead.view"], fieldSet: "base", sets: [] },
  }),
  kpi({
    key: "time_to_assignment",
    family: "OPERATIONAL",
    unit: "DURATION",
    definition: "How long a new job waits for its first lead technician assignment.",
    formula: "median(first LEAD JobAssignment.assignedAt - Job.createdAt) over jobs created in the period that have been assigned.",
    sourceRecords: ["Job", "JobAssignment"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Job.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "DISPATCHER",
    access: DISPATCH,
  }),
  kpi({
    key: "time_to_arrival",
    family: "OPERATIONAL",
    unit: "DURATION",
    definition: "How long it takes from the first lead technician assignment to the first recorded arrival at the job.",
    formula: "median(first ArrivalVerification.arrivedAt (not MANAGER_REJECTED) - first LEAD JobAssignment.assignedAt) over jobs created in the period with both.",
    sourceRecords: ["Job", "JobAssignment", "ArrivalVerification"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Job.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "DISPATCHER",
    access: DISPATCH,
  }),
  kpi({
    key: "job_duration",
    family: "OPERATIONAL",
    unit: "DURATION",
    definition: "How long work on a job takes, from start to completion.",
    formula: "median(Job.completedAt - Job.startedAt) over jobs completed in the period that have a start time.",
    sourceRecords: ["Job"],
    period: { semantics: "EVENT_IN_PERIOD", anchor: "Job.completedAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "COO",
    access: OPERATIONAL,
  }),
  kpi({
    key: "jobs_per_employee",
    family: "OPERATIONAL",
    unit: "RATIO",
    definition: "Completed jobs per technician who led at least one of them. A group figure only: never listed or ranked per employee.",
    formula: "count(jobs completed in the period with a LEAD assignee) / count(distinct LEAD assignees of those jobs), per group.",
    sourceRecords: ["Job", "JobAssignment", "OrganizationalAssignment"],
    period: { semantics: "EVENT_IN_PERIOD", anchor: "Job.completedAt" },
    orgLevels: ALL_LEVELS,
    attribution:
      "The unit of the lead technician's PRIMARY OrganizationalAssignment effective at Job.completedAt (spec 3), never today's; jobs whose technician had no placement then are left out. The job itself must be in the viewer's scope too.",
    dataOwnerRole: "COO",
    access: OPERATIONAL,
  }),
  kpi({
    key: "completed_jobs",
    family: "OPERATIONAL",
    unit: "COUNT",
    definition: "Jobs completed in the period.",
    formula: "count(Job where completedAt in the period).",
    sourceRecords: ["Job"],
    period: { semantics: "EVENT_IN_PERIOD", anchor: "Job.completedAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "COO",
    access: OPERATIONAL,
  }),
  kpi({
    key: "revisit_rate",
    family: "OPERATIONAL",
    unit: "RATE",
    definition: "Share of completed jobs that needed more than one visit.",
    formula: "count(jobs created in the period, completed, with currentVisitNumber > 1) / count(jobs created in the period, completed).",
    sourceRecords: ["Job"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Job.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "COO",
    access: OPERATIONAL,
  }),
  kpi({
    key: "cancellation_rate",
    family: "OPERATIONAL",
    unit: "RATE",
    definition: "Share of jobs created in the period that are cancelled.",
    formula: "count(jobs created in the period with status CANCELLED) / count(jobs created in the period).",
    sourceRecords: ["Job"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Job.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "COO",
    access: OPERATIONAL,
  }),
  kpi({
    key: "unassigned_jobs",
    family: "OPERATIONAL",
    unit: "COUNT",
    definition: "Open jobs that have no active lead technician right now.",
    formula: "count(Job with status CREATED, PENDING_ASSIGNMENT or RESCHEDULED, not archived, and no ACTIVE LEAD JobAssignment) at request time.",
    sourceRecords: ["Job", "JobAssignment"],
    period: { semantics: "SNAPSHOT", anchor: "request time" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "DISPATCHER",
    access: DISPATCH,
  }),
  kpi({
    key: "dispatch_recommendation_acceptance_rate",
    family: "OPERATIONAL",
    unit: "RATE",
    definition: "Dispatch efficiency (1 of 2): share of jobs whose first lead assignment took the dispatch recommendation as proposed.",
    formula: "count(first LEAD JobAssignment.method = RECOMMENDATION_APPROVED) / count(jobs with a first LEAD assignment), over jobs created in the period.",
    sourceRecords: ["Job", "JobAssignment"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Job.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "DISPATCHER",
    access: DISPATCH,
  }),
  kpi({
    key: "dispatch_decision_latency",
    family: "OPERATIONAL",
    unit: "DURATION",
    definition: "Dispatch efficiency (2 of 2): how long a dispatch recommendation waits for the dispatcher's decision.",
    formula: "median(DispatchRecommendation.decidedAt - generatedAt) over decided recommendations of jobs created in the period.",
    sourceRecords: ["Job", "DispatchRecommendation"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Job.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "DISPATCHER",
    access: DISPATCH,
  }),

  // ── Lead (spec 13.1 "Lead source performance", "Conversion rate", "Recovery outcomes") ──
  kpi({
    key: "lead_volume_by_source",
    family: "LEAD",
    unit: "COUNT",
    breakdown: "LEAD_SOURCE",
    definition: "New leads per lead source.",
    formula: "count(Lead created in the period, status not DUPLICATE), per LeadSource (null = no source).",
    sourceRecords: ["Lead", "LeadSource"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Lead.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: LEAD_ATTRIBUTION,
    dataOwnerRole: "LEAD_OPERATIONS_MANAGER",
    access: LEAD,
  }),
  kpi({
    key: "lead_conversion_rate_by_source",
    family: "LEAD",
    unit: "RATE",
    breakdown: "LEAD_SOURCE",
    definition: "Share of new leads that were converted into a job, per lead source.",
    formula: "count(leads created in the period with status CONVERTED) / count(leads created in the period, status not DUPLICATE), per LeadSource.",
    sourceRecords: ["Lead", "LeadSource"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Lead.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: LEAD_ATTRIBUTION,
    dataOwnerRole: "LEAD_OPERATIONS_MANAGER",
    access: LEAD,
  }),
  kpi({
    key: "recovery_rate",
    family: "LEAD",
    unit: "RATE",
    definition: "Share of decided recovery cases that were recovered.",
    formula: "count(cases with recoveredAt) / count(cases with status RECOVERED, NOT_RECOVERED or CLOSED), over cases whose lost visit (outcomeAt) is in the period.",
    sourceRecords: ["LeadRecoveryCase"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "LeadRecoveryCase.outcomeAt" },
    orgLevels: ALL_LEVELS,
    attribution: CASE_ATTRIBUTION,
    dataOwnerRole: "LEAD_OPERATIONS_MANAGER",
    access: LEAD,
  }),
  kpi({
    key: "recovery_confirmed_revenue",
    family: "LEAD",
    unit: "MONEY",
    definition: "CONFIRMED revenue of recovered cases (amounts recorded when the recovery was confirmed). Never mixed with estimates (spec 9.7).",
    formula: "sum(recoveredAmountMinor) per currency over cases with recoveredAt and status RECOVERED or CLOSED whose lost visit (outcomeAt) is in the period.",
    sourceRecords: ["LeadRecoveryCase"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "LeadRecoveryCase.outcomeAt" },
    orgLevels: ALL_LEVELS,
    attribution: CASE_ATTRIBUTION,
    dataOwnerRole: "LEAD_OPERATIONS_MANAGER",
    access: LEAD,
  }),
  kpi({
    key: "recovery_estimated_value",
    family: "LEAD",
    unit: "MONEY",
    estimate: true,
    definition: "ESTIMATED value still open in recovery (the employee-entered or quoted estimate). An estimate, never revenue (spec 9.7).",
    formula: "sum(estimatedValueMinor) per currency over open cases (status not RECOVERED, NOT_RECOVERED or CLOSED) whose lost visit (outcomeAt) is in the period.",
    sourceRecords: ["LeadRecoveryCase"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "LeadRecoveryCase.outcomeAt" },
    orgLevels: ALL_LEVELS,
    attribution: CASE_ATTRIBUTION,
    dataOwnerRole: "LEAD_OPERATIONS_MANAGER",
    access: LEAD,
  }),

  // ── Executive (spec 13.1); revenue, costs and compensation are the financial keys below ──
  kpi({
    key: "job_volume",
    family: "EXECUTIVE",
    unit: "COUNT",
    definition: "Jobs created in the period.",
    formula: "count(Job where createdAt in the period).",
    sourceRecords: ["Job"],
    period: { semantics: "COHORT_IN_PERIOD", anchor: "Job.createdAt" },
    orgLevels: ALL_LEVELS,
    attribution: JOB_ATTRIBUTION,
    dataOwnerRole: "COO",
    access: EXECUTIVE,
  }),
  kpi({
    key: "employee_productivity",
    family: "EXECUTIVE",
    unit: "RATIO",
    definition: "Completed jobs per scheduled shift hour. Development use only; never a per-employee ranking. " + TASK3,
    formula: "count(jobs completed in the period) / sum(scheduled shift hours in the period), per group.",
    sourceRecords: ["Job", "JobAssignment", "Shift", "OrganizationalAssignment"],
    period: { semantics: "EVENT_IN_PERIOD", anchor: "Job.completedAt" },
    orgLevels: ALL_LEVELS,
    attribution: "The unit of the employee's PRIMARY OrganizationalAssignment effective at the event time (spec 3).",
    dataOwnerRole: "COO",
    access: EXECUTIVE,
  }),

  // ── Financial (spec 13.1, 13.3): ledger-derived, computed by Task 3 ──
  ...(
    [
      ["sold_revenue", "Approved (sold) amounts of jobs."],
      ["charged_revenue", "Amounts charged to customers."],
      ["collected_revenue", "Payments collected."],
      ["outstanding_amount", "Charged but not yet collected amounts."],
      ["material_costs", "Cost of materials used on jobs."],
      ["direct_costs", "Direct costs of jobs (materials; other direct costs are not modelled yet)."],
      ["gross_profit", "Charged revenue minus direct costs, per currency."],
      ["refunds", "Refunded amounts."],
      ["adjustments", "Approved financial adjustments."],
      ["chargebacks", "Chargeback amounts."],
    ] as const
  ).map(([key, definition]) =>
    kpi({
      key,
      family: "FINANCIAL",
      unit: "MONEY",
      definition: `${definition} ${TASK3}`,
      formula: "Ledger-derived sum of minor units per currency (Task 3 defines the entry types).",
      sourceRecords: ["LedgerEntry"],
      period: { semantics: "EVENT_IN_PERIOD", anchor: "LedgerEntry.occurredAt" },
      orgLevels: ALL_LEVELS,
      attribution: LEDGER_ATTRIBUTION,
      dataOwnerRole: "FINANCE_DIRECTOR",
      access: FINANCIAL,
    }),
  ),
  kpi({
    key: "reconciliation_exceptions_open",
    family: "FINANCIAL",
    unit: "COUNT",
    definition: "Reconciliation exceptions still open. " + TASK3,
    formula: "count(ReconciliationException with an open status) at request time.",
    sourceRecords: ["ReconciliationException"],
    period: { semantics: "SNAPSHOT", anchor: "request time" },
    orgLevels: ALL_LEVELS,
    attribution: "The org unit snapshotted on the exception (ReconciliationException.orgUnitId).",
    dataOwnerRole: "FINANCE_DIRECTOR",
    access: FINANCIAL,
  }),
  kpi({
    key: "reconciliation_exceptions_resolved",
    family: "FINANCIAL",
    unit: "COUNT",
    definition: "Reconciliation exceptions resolved in the period. " + TASK3,
    formula: "count(ReconciliationException resolved in the period).",
    sourceRecords: ["ReconciliationException"],
    period: { semantics: "EVENT_IN_PERIOD", anchor: "ReconciliationException resolution time" },
    orgLevels: ALL_LEVELS,
    attribution: "The org unit snapshotted on the exception (ReconciliationException.orgUnitId).",
    dataOwnerRole: "FINANCE_DIRECTOR",
    access: FINANCIAL,
  }),
  ...(
    [
      ["compensation_expense", "Employee compensation expense."],
      ["commission_expense", "Commission expense."],
    ] as const
  ).map(([key, definition]) =>
    kpi({
      key,
      family: "FINANCIAL",
      unit: "MONEY",
      status: "BLOCKED_ON_SPEC",
      blockedReason: "The compensation model is not specified (spec 28.4); no number is ever invented for it.",
      definition,
      formula: "Not defined until the compensation spec exists.",
      sourceRecords: [],
      period: { semantics: "EVENT_IN_PERIOD", anchor: "not defined" },
      orgLevels: ALL_LEVELS,
      attribution: "Not defined until the compensation spec exists.",
      dataOwnerRole: "FINANCE_DIRECTOR",
      access: FINANCIAL,
    }),
  ),
];

const BY_KEY: ReadonlyMap<string, KpiDefinition> = new Map(KPI_CATALOG.map((entry) => [entry.key, entry]));

/** The catalog entry for `key`, or undefined for an unknown key. */
export function findKpi(key: string): KpiDefinition | undefined {
  return BY_KEY.get(key);
}
