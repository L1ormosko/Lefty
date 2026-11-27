import { describe, expect, it } from "vitest";
import { CATALOGS, SUPPORTED_LOCALES } from "@/lib/i18n";
import { DISPATCH_KPI_SET, KPI_CATALOG, findKpi } from "@/lib/kpi-catalog";
import { isKpiComputed } from "@/server/analytics";
import { PERMISSION_CATALOG, ROLE_TEMPLATES, permissionKey } from "@/server/authz";

/** The one KPI catalog (spec 13.4) and its contracts with the permission catalog (Phase 6 Task 1). */

const PERMISSIONS = new Set(PERMISSION_CATALOG.map(permissionKey));
const TEMPLATE_KEYS = new Set(ROLE_TEMPLATES.map((template) => template.key));

/** Every metric Part 13.1-13.3 names, mapped to the catalog key(s) that carry it. */
const PART_13: Record<string, string[]> = {
  "13.1 Revenue": ["charged_revenue"],
  "13.1 Collections": ["collected_revenue"],
  "13.1 Outstanding balance": ["outstanding_amount"],
  "13.1 Job volume": ["job_volume"],
  "13.1 Conversion rate": ["lead_conversion_rate_by_source"],
  "13.1 Direct costs": ["direct_costs"],
  "13.1 Gross profit": ["gross_profit"],
  "13.1 Compensation": ["compensation_expense"],
  "13.1 Employee productivity": ["employee_productivity"],
  "13.1 Lead source performance": ["lead_volume_by_source", "lead_conversion_rate_by_source"],
  "13.1 Recovery outcomes": ["recovery_rate", "recovery_confirmed_revenue", "recovery_estimated_value"],
  "13.2 Lead response time": ["lead_response_time"],
  "13.2 Time to assignment": ["time_to_assignment"],
  "13.2 Time to arrival": ["time_to_arrival"],
  "13.2 Job duration": ["job_duration"],
  "13.2 Jobs per employee": ["jobs_per_employee"],
  "13.2 Completed jobs": ["completed_jobs"],
  "13.2 Revisit rate": ["revisit_rate"],
  "13.2 Cancellation rate": ["cancellation_rate"],
  "13.2 Unassigned jobs": ["unassigned_jobs"],
  "13.2 Dispatch efficiency": ["dispatch_recommendation_acceptance_rate", "dispatch_decision_latency"],
  "13.3 Sold revenue": ["sold_revenue"],
  "13.3 Charged revenue": ["charged_revenue"],
  "13.3 Collected revenue": ["collected_revenue"],
  "13.3 Outstanding amounts": ["outstanding_amount"],
  "13.3 Material costs": ["material_costs"],
  "13.3 Direct costs": ["direct_costs"],
  "13.3 Commission expense": ["commission_expense"],
  "13.3 Refunds": ["refunds"],
  "13.3 Adjustments": ["adjustments"],
  "13.3 Reconciliation exceptions": ["reconciliation_exceptions_open", "reconciliation_exceptions_resolved"],
};

describe("KPI catalog", () => {
  it("has unique, lower-snake keys with a label key derived from the key", () => {
    const keys = KPI_CATALOG.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of KPI_CATALOG) {
      expect(entry.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(entry.labelKey).toBe(`KPI.${entry.key.toUpperCase()}`);
    }
  });

  it.each(Object.entries(PART_13))("covers %s", (_metric, keys) => {
    for (const key of keys) expect(findKpi(key), key).toBeDefined();
  });

  it("documents every field spec 13.4 requires on every entry", () => {
    for (const entry of KPI_CATALOG) {
      expect(entry.definition.length, entry.key).toBeGreaterThan(10);
      expect(entry.formula.length, entry.key).toBeGreaterThan(10);
      expect(entry.attribution.length, entry.key).toBeGreaterThan(10);
      expect(entry.period.anchor.length, entry.key).toBeGreaterThan(0);
      expect(entry.orgLevels, entry.key).toContain("TENANT");
      if (entry.status === "ACTIVE") expect(entry.sourceRecords.length, entry.key).toBeGreaterThan(0);
    }
  });

  it("names only real permissions and role templates", () => {
    for (const entry of KPI_CATALOG) {
      expect(entry.access.permissions.length, entry.key).toBeGreaterThan(0);
      for (const permission of entry.access.permissions) expect(PERMISSIONS.has(permission), `${entry.key}: ${permission}`).toBe(true);
      for (const extra of entry.access.requiresAlso ?? []) expect(PERMISSIONS.has(extra.permission), `${entry.key}: ${extra.permission}`).toBe(true);
      expect(TEMPLATE_KEYS.has(entry.dataOwnerRole), `${entry.key}: ${entry.dataOwnerRole}`).toBe(true);
    }
  });

  it("keeps compensation and commission expense BLOCKED_ON_SPEC with a reason (spec 28.4)", () => {
    const blocked = KPI_CATALOG.filter((entry) => entry.status === "BLOCKED_ON_SPEC").map((entry) => entry.key).sort();
    expect(blocked).toEqual(["commission_expense", "compensation_expense"]);
    for (const key of blocked) expect(findKpi(key)?.blockedReason).toContain("28.4");
  });

  it("places exactly the dispatcher's subset in the dispatch_kpis set", () => {
    const dispatch = KPI_CATALOG.filter((entry) => entry.access.sets.includes(DISPATCH_KPI_SET)).map((entry) => entry.key).sort();
    expect(dispatch).toEqual(["dispatch_decision_latency", "dispatch_recommendation_acceptance_rate", "time_to_arrival", "time_to_assignment", "unassigned_jobs"]);
    for (const key of dispatch) expect(findKpi(key)?.access.permissions).toEqual(["analytics_operational.view"]);
  });

  it("computes every ACTIVE KPI and no BLOCKED_ON_SPEC one", () => {
    for (const entry of KPI_CATALOG) expect(isKpiComputed(entry.key), entry.key).toBe(entry.status === "ACTIVE");
  });

  it("gates financial KPIs by financial_reports.view plus the source module's sensitive set (Phase 6 Task 3)", () => {
    const financial = KPI_CATALOG.filter((entry) => entry.family === "FINANCIAL");
    for (const entry of financial) expect(entry.access.permissions, entry.key).toEqual(["financial_reports.view"]);
    const extra = Object.fromEntries(financial.filter((entry) => entry.access.requiresAlso).map((entry) => [entry.key, entry.access.requiresAlso]));
    const cost = [{ permission: "materials.view", fieldSet: "cost" }];
    expect(extra).toEqual({ sold_revenue: [{ permission: "job_outcomes.view", fieldSet: "financial" }], material_costs: cost, direct_costs: cost, gross_profit: cost });
  });

  it("labels the recovery estimate as an estimate and keeps confirmed revenue separate (spec 9.7)", () => {
    expect(findKpi("recovery_estimated_value")?.estimate).toBe(true);
    expect(findKpi("recovery_confirmed_revenue")?.estimate).toBeUndefined();
  });

  it("has a label for every KPI in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const entry of KPI_CATALOG) expect(CATALOGS[locale].messages[entry.labelKey], `${locale} ${entry.labelKey}`).toBeTruthy();
    }
  });
});
