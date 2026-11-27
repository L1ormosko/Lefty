/**
 * Dashboard definitions (spec 13.1-13.3, 5.x workspace widgets): pure data, no Prisma, no Next. A dashboard is a family
 * permission plus sections; a section is a list of KPI keys of the ONE catalog (`src/lib/kpi-catalog.ts`) with the grouping
 * and period granularity it is shown at. Dashboards never define a number themselves: what a figure means is the catalog's.
 *
 * Two layers of access (Phase 6 Task 1 contract): the family permission opens the dashboard; every KPI on it is still checked
 * against its own catalog access, and KPIs the viewer may not see come back as `hidden` (`src/server/analytics/dashboards.ts`).
 * No dashboard lists individuals: every KPI here is a group figure (spec 10.3, no per-employee ranking).
 */
import type { KpiGranularity } from "./kpi-aggregation";
import { DISPATCH_KPI_SET, type KpiFamily, type KpiOrgLevel } from "./kpi-catalog";

export const DASHBOARD_IDS = ["executive", "state_regional", "city_branch", "finance", "lead", "operational"] as const;
export type DashboardId = (typeof DASHBOARD_IDS)[number];

export interface DashboardSection {
  /** Stable key, unique within the dashboard; the label is `DASHBOARD.SECTION.<KEY>` (the same key means the same thing everywhere). */
  key: string;
  labelKey: string;
  /** Org level the section's KPIs are grouped by: TENANT = one figure for the viewer's scope; lower levels compare org units. */
  groupBy: KpiOrgLevel;
  /** Default period granularity of the section (the request may override it for the whole dashboard). */
  period: KpiGranularity;
  kpiKeys: readonly string[];
}

export interface DashboardDefinition {
  id: DashboardId;
  /** i18n key of the dashboard's name (`DASHBOARD.<ID>`). */
  labelKey: string;
  family: KpiFamily;
  /** The family permission that opens the dashboard (`analytics_<family>.view`). */
  permission: string;
  /**
   * Record sets a set-qualified family grant may name and still open the dashboard (the Dispatcher's
   * `analytics_operational.view { set: "dispatch_kpis" }`); its KPIs outside that set then come back hidden.
   */
  familySets: readonly string[];
  /** Date range used when the request names none: the last N days, today included, in the tenant's time zone. */
  defaultRangeDays: number;
  sections: readonly DashboardSection[];
}

function section(key: string, groupBy: KpiOrgLevel, period: KpiGranularity, kpiKeys: readonly string[]): DashboardSection {
  return { key, labelKey: `DASHBOARD.SECTION.${key.toUpperCase()}`, groupBy, period, kpiKeys };
}

function dashboard(entry: Omit<DashboardDefinition, "labelKey" | "familySets"> & { familySets?: readonly string[] }): DashboardDefinition {
  return { labelKey: `DASHBOARD.${entry.id.toUpperCase()}`, familySets: [], ...entry };
}

/** The dispatch subset (catalog set `dispatch_kpis`): what a dispatcher sees of the operational dashboard. */
const DISPATCH_KPIS = [
  "unassigned_jobs",
  "time_to_assignment",
  "time_to_arrival",
  "dispatch_recommendation_acceptance_rate",
  "dispatch_decision_latency",
] as const;

const UNIT_COMPARISON = ["job_volume", "completed_jobs", "job_duration", "revisit_rate", "cancellation_rate", "time_to_arrival"] as const;
/** Local revenue widgets (spec 5.3, 5.4): checked per KPI against the viewer's own scoped `financial_reports.view`. */
const LOCAL_REVENUE = ["charged_revenue", "collected_revenue", "outstanding_amount"] as const;

export const DASHBOARDS: readonly DashboardDefinition[] = [
  dashboard({
    id: "executive",
    family: "EXECUTIVE",
    permission: "analytics_executive.view",
    defaultRangeDays: 90,
    sections: [
      section("company", "TENANT", "MONTH", [
        "job_volume",
        "completed_jobs",
        "cancellation_rate",
        "charged_revenue",
        "collected_revenue",
        "outstanding_amount",
        "gross_profit",
        "lead_conversion_rate_by_source",
        "recovery_rate",
        "recovery_confirmed_revenue",
        "recovery_estimated_value",
        "employee_productivity",
        "compensation_expense",
        "commission_expense",
      ]),
      section("state_comparison", "STATE", "TOTAL", ["job_volume", "completed_jobs", "cancellation_rate", "revisit_rate", "charged_revenue", "collected_revenue", "gross_profit"]),
      section("region_comparison", "REGION", "TOTAL", ["job_volume", "completed_jobs", "cancellation_rate", "charged_revenue", "collected_revenue"]),
    ],
  }),
  dashboard({
    id: "state_regional",
    family: "OPERATIONAL",
    permission: "analytics_operational.view",
    defaultRangeDays: 30,
    sections: [
      section("overview", "TENANT", "WEEK", [...UNIT_COMPARISON, "unassigned_jobs", "lead_response_time", "jobs_per_employee"]),
      section("region_comparison", "REGION", "TOTAL", UNIT_COMPARISON),
      section("city_comparison", "CITY", "TOTAL", UNIT_COMPARISON),
      section("local_revenue", "CITY", "TOTAL", LOCAL_REVENUE),
    ],
  }),
  dashboard({
    id: "city_branch",
    family: "OPERATIONAL",
    permission: "analytics_operational.view",
    defaultRangeDays: 14,
    sections: [
      section("overview", "TENANT", "DAY", [...DISPATCH_KPIS.slice(0, 3), "completed_jobs", "job_duration", "jobs_per_employee", "revisit_rate", "cancellation_rate"]),
      section("branch_comparison", "BRANCH", "TOTAL", UNIT_COMPARISON),
      section("local_revenue", "TENANT", "TOTAL", LOCAL_REVENUE),
    ],
  }),
  dashboard({
    id: "finance",
    family: "FINANCIAL",
    permission: "analytics_financial.view",
    defaultRangeDays: 90,
    sections: [
      section("totals", "TENANT", "MONTH", [
        "charged_revenue",
        "collected_revenue",
        "outstanding_amount",
        "refunds",
        "adjustments",
        "chargebacks",
        "sold_revenue",
        "material_costs",
        "direct_costs",
        "gross_profit",
        "compensation_expense",
        "commission_expense",
      ]),
      section("reconciliation", "TENANT", "TOTAL", ["reconciliation_exceptions_open", "reconciliation_exceptions_resolved"]),
      section("state_comparison", "STATE", "TOTAL", ["charged_revenue", "collected_revenue", "outstanding_amount", "gross_profit"]),
    ],
  }),
  dashboard({
    id: "lead",
    family: "LEAD",
    permission: "analytics_lead.view",
    defaultRangeDays: 30,
    sections: [
      section("overview", "TENANT", "WEEK", [
        "lead_volume_by_source",
        "lead_conversion_rate_by_source",
        "lead_response_time",
        "recovery_rate",
        "recovery_confirmed_revenue",
        "recovery_estimated_value",
      ]),
      section("city_comparison", "CITY", "TOTAL", ["lead_volume_by_source", "lead_conversion_rate_by_source", "lead_response_time", "recovery_rate"]),
    ],
  }),
  dashboard({
    id: "operational",
    family: "OPERATIONAL",
    permission: "analytics_operational.view",
    familySets: [DISPATCH_KPI_SET],
    defaultRangeDays: 7,
    sections: [
      section("dispatch", "TENANT", "DAY", DISPATCH_KPIS),
      section("work", "TENANT", "DAY", ["job_volume", "completed_jobs", "job_duration", "jobs_per_employee", "revisit_rate", "cancellation_rate", "lead_response_time", "employee_productivity"]),
    ],
  }),
];

const BY_ID: ReadonlyMap<string, DashboardDefinition> = new Map(DASHBOARDS.map((entry) => [entry.id, entry]));

/** The dashboard definition for `id`, or undefined for an unknown id. */
export function findDashboard(id: string): DashboardDefinition | undefined {
  return BY_ID.get(id);
}

/** Every distinct KPI key a dashboard shows, in first-appearance order. */
export function dashboardKpiKeys(definition: DashboardDefinition): string[] {
  return [...new Set(definition.sections.flatMap((entry) => entry.kpiKeys))];
}
