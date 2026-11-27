import { describe, expect, it } from "vitest";
import { DASHBOARDS, DASHBOARD_IDS, dashboardKpiKeys, findDashboard } from "@/lib/dashboards";
import { CATALOGS, SUPPORTED_LOCALES } from "@/lib/i18n";
import { DISPATCH_KPI_SET, KPI_CATALOG, findKpi } from "@/lib/kpi-catalog";
import { isPermissionKey } from "@/server/authz";

/** The dashboard definitions are pure data over the one KPI catalog (spec 13.4: dashboards reference KPIs by key only). */
describe("src/lib/dashboards.ts", () => {
  it("defines each dashboard once, findable by id", () => {
    expect(DASHBOARDS.map((entry) => entry.id)).toEqual([...DASHBOARD_IDS]);
    for (const id of DASHBOARD_IDS) expect(findDashboard(id)?.id).toBe(id);
    expect(findDashboard("nope")).toBeUndefined();
  });

  it("opens each dashboard with its family's analytics permission", () => {
    for (const entry of DASHBOARDS) {
      expect(entry.permission).toBe(`analytics_${entry.family.toLowerCase()}.view`);
      expect(isPermissionKey(entry.permission), entry.permission).toBe(true);
      expect(entry.familySets.every((set) => set === DISPATCH_KPI_SET)).toBe(true);
      expect(entry.defaultRangeDays).toBeGreaterThan(0);
      expect(entry.defaultRangeDays).toBeLessThanOrEqual(366);
    }
  });

  it("references only catalog KPIs, at an org level each KPI supports, with unique section keys", () => {
    for (const entry of DASHBOARDS) {
      const sectionKeys = entry.sections.map((section) => section.key);
      expect(new Set(sectionKeys).size, entry.id).toBe(sectionKeys.length);
      for (const section of entry.sections) {
        expect(section.kpiKeys.length).toBeGreaterThan(0);
        expect(new Set(section.kpiKeys).size, `${entry.id}.${section.key}`).toBe(section.kpiKeys.length);
        for (const key of section.kpiKeys) {
          const kpi = findKpi(key);
          expect(kpi, `${entry.id}.${section.key}: ${key}`).toBeDefined();
          expect(kpi?.orgLevels).toContain(section.groupBy);
        }
      }
    }
  });

  it("gives the operational dashboard a dispatch section that is exactly the catalog's dispatch_kpis set", () => {
    const dispatchSet = KPI_CATALOG.filter((kpi) => kpi.access.sets.includes(DISPATCH_KPI_SET)).map((kpi) => kpi.key).sort();
    const operational = findDashboard("operational");
    expect(operational?.familySets).toEqual([DISPATCH_KPI_SET]);
    expect([...(operational?.sections.find((section) => section.key === "dispatch")?.kpiKeys ?? [])].sort()).toEqual(dispatchSet);
  });

  it("shows the BLOCKED_ON_SPEC KPIs on the executive and finance dashboards (as status only, never a value)", () => {
    for (const id of ["executive", "finance"] as const) {
      const keys = dashboardKpiKeys(findDashboard(id) ?? DASHBOARDS[0]);
      expect(keys).toEqual(expect.arrayContaining(["compensation_expense", "commission_expense"]));
    }
  });

  it("has dashboard and section labels in every locale", () => {
    const labels = DASHBOARDS.flatMap((entry) => [entry.labelKey, ...entry.sections.map((section) => section.labelKey)]);
    for (const locale of SUPPORTED_LOCALES) {
      for (const label of [...labels, "DASHBOARD.KPI_HIDDEN"]) expect(CATALOGS[locale].messages[label], `${locale} ${label}`).toBeTruthy();
    }
  });
});
