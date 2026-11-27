import { describe, expect, it } from "vitest";
import { ReportExportFormat, ReportExportStatus } from "@prisma/client";
import { CATALOGS, SUPPORTED_LOCALES } from "@/lib/i18n";
import { PERMISSION_CATALOG, ROLE_TEMPLATES, customRoleRequiresMfa } from "@/server/authz";

/** Phase 6 permission catalog and role templates (spec 4.5 "Financial reports", 5.1-5.10 workspaces, 13.1-13.5, 22.2). */

const FAMILIES = ["analytics_executive", "analytics_operational", "analytics_financial", "analytics_lead"];
const PHASE6_MODULES = [...FAMILIES, "reports"];
const MANAGERS = ["STATE_MANAGER", "REGIONAL_MANAGER", "CITY_MANAGER"];

const template = (key: string) => {
  const found = ROLE_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new Error(`no template ${key}`);
  return found;
};
const grant = (key: string, permission: string) => template(key).grants.find((g) => g.permission === permission);
const holds = (key: string, permission: string) => grant(key, permission) !== undefined;
/** The Phase 6 permissions a template holds, sorted. */
const phase6Of = (key: string) =>
  template(key).grants.map((g) => g.permission).filter((p) => PHASE6_MODULES.includes(p.split(".")[0])).sort();
const actions = (module: string) => PERMISSION_CATALOG.filter((p) => p.module === module).map((p) => p.action);
const sensitive = (key: string) => PERMISSION_CATALOG.find((p) => `${p.module}.${p.action.toLowerCase()}` === key)?.sensitive;

describe("Phase 6 permission catalog", () => {
  it("has one VIEW per dashboard family and the report builder's VIEW, CREATE, EXPORT, MANAGE", () => {
    for (const family of FAMILIES) expect(actions(family), family).toEqual(["VIEW"]);
    expect(actions("reports")).toEqual(["VIEW", "CREATE", "EXPORT", "MANAGE"]);
  });

  it("marks financial dashboards and exports as sensitive (spec 22.2, 13.5)", () => {
    expect(sensitive("analytics_financial.view")).toBe(true);
    expect(sensitive("reports.export")).toBe(true);
    for (const key of ["analytics_executive.view", "analytics_operational.view", "analytics_lead.view", "reports.view", "reports.create", "reports.manage"]) {
      expect(sensitive(key), key).toBe(false);
    }
  });

  it("makes a custom role holding a financial dashboard or export require MFA", () => {
    expect(customRoleRequiresMfa([{ permission: "analytics_financial.view" }])).toBe(true);
    expect(customRoleRequiresMfa([{ permission: "reports.export" }])).toBe(true);
    expect(customRoleRequiresMfa([{ permission: "analytics_operational.view" }, { permission: "reports.view" }])).toBe(false);
  });
});

describe("Phase 6 role templates", () => {
  it("gives the Owner every analytics and report permission", () => {
    expect(phase6Of("OWNER_CEO")).toEqual(
      PERMISSION_CATALOG.filter((p) => PHASE6_MODULES.includes(p.module)).map((p) => `${p.module}.${p.action.toLowerCase()}`).sort(),
    );
  });

  it("gives the COO executive and operational dashboards and the report builder without export", () => {
    expect(phase6Of("COO")).toEqual(["analytics_executive.view", "analytics_operational.view", "reports.create", "reports.view"]);
  });

  it("gives Finance financial dashboards and exports, and no operational dashboards (spec 26.3)", () => {
    expect(phase6Of("FINANCE_DIRECTOR")).toEqual(["analytics_financial.view", "reports.create", "reports.export", "reports.view"]);
  });

  it("gives managers scoped operational dashboards and reports; local revenue only through their financial grants", () => {
    for (const key of MANAGERS) {
      expect(phase6Of(key), key).toEqual(["analytics_operational.view", "reports.create", "reports.view"]);
      // The revenue widgets' KPIs check financial_reports.view, which managers already hold (scoped, spec 4.5).
      expect(holds(key, "financial_reports.view"), key).toBe(true);
      expect(template(key).suggestedScopeTypes).toEqual(["ORG_UNIT"]);
    }
  });

  it("gives Lead Operations lead analytics and lead exports", () => {
    expect(phase6Of("LEAD_OPERATIONS_MANAGER")).toEqual(["analytics_lead.view", "reports.create", "reports.export", "reports.view"]);
    expect(holds("LEAD_OPERATIONS_MANAGER", "leads.export")).toBe(true);
  });

  it("limits the Dispatcher to the dispatch subset of operational analytics", () => {
    expect(phase6Of("DISPATCHER")).toEqual(["analytics_operational.view"]);
    expect(grant("DISPATCHER", "analytics_operational.view")?.conditions).toEqual({ set: "dispatch_kpis" });
  });

  it("gives HR the report builder only, and the Technician, Team Leader and Customer Relations nothing", () => {
    expect(phase6Of("HR_MANAGER")).toEqual(["reports.create", "reports.view"]);
    for (const key of ["TECHNICIAN", "TEAM_LEADER", "CUSTOMER_RELATIONS"]) expect(phase6Of(key), key).toEqual([]);
  });

  it("lets only the Owner share views with roles and only Owner, Finance and Lead Operations export", () => {
    expect(ROLE_TEMPLATES.filter((t) => holds(t.key, "reports.manage")).map((t) => t.key)).toEqual(["OWNER_CEO"]);
    expect(ROLE_TEMPLATES.filter((t) => holds(t.key, "reports.export")).map((t) => t.key).sort()).toEqual(
      ["FINANCE_DIRECTOR", "LEAD_OPERATIONS_MANAGER", "OWNER_CEO"],
    );
  });

  it("gives financial dashboards only to the Owner and Finance", () => {
    expect(ROLE_TEMPLATES.filter((t) => holds(t.key, "analytics_financial.view")).map((t) => t.key).sort()).toEqual(["FINANCE_DIRECTOR", "OWNER_CEO"]);
  });
});

describe("Phase 6 labels exist in every catalog", () => {
  const families: Record<string, readonly string[]> = {
    "ANALYTICS.FAMILY.": ["EXECUTIVE", "OPERATIONAL", "FINANCIAL", "LEAD"],
    "REPORT_EXPORT.FORMAT.": Object.values(ReportExportFormat),
    "REPORT_EXPORT.STATUS.": Object.values(ReportExportStatus),
  };

  for (const [prefix, members] of Object.entries(families)) {
    it(`${prefix}*`, () => {
      for (const locale of SUPPORTED_LOCALES) {
        for (const member of members) expect(CATALOGS[locale].messages[`${prefix}${member}`], `${locale} ${prefix}${member}`).toBeTruthy();
      }
    });
  }

  it("has one family label per analytics_<family> module", () => {
    expect(FAMILIES.map((m) => m.replace("analytics_", "").toUpperCase())).toEqual(families["ANALYTICS.FAMILY."]);
  });
});
