import { describe, expect, it } from "vitest";
import {
  AccountingMappingStatus,
  AutomationExecutionResult,
  AutomationRuleStatus,
  BackgroundJobStatus,
  ExportBatchKind,
  ExportBatchStatus,
  IntegrationCategory,
  IntegrationStatus,
  WebhookHandlingStatus,
} from "@prisma/client";
import { CATALOGS, SUPPORTED_LOCALES } from "@/lib/i18n";
import { PERMISSION_CATALOG, ROLE_TEMPLATES, customRoleRequiresMfa } from "@/server/authz";
import { APPROVAL_SUBJECT_TYPES } from "@/server/approvals/schemas";
import { APPROVAL_POLICY_SPECS } from "../../prisma/seed/finance-specs";

/** Phase 7 permission catalog, role templates, approval policies and labels (spec 15, 18, 11.9). */

const PHASE7_MODULES = ["background_jobs", "automation", "integrations", "payroll_exports", "accounting_exports"];

const template = (key: string) => {
  const found = ROLE_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new Error(`no template ${key}`);
  return found;
};
const holds = (key: string, permission: string) => template(key).grants.some((g) => g.permission === permission);
const phase7Of = (key: string) =>
  template(key).grants.map((g) => g.permission).filter((p) => PHASE7_MODULES.includes(p.split(".")[0])).sort();
const actions = (module: string) => PERMISSION_CATALOG.filter((p) => p.module === module).map((p) => p.action);
const sensitive = (key: string) => PERMISSION_CATALOG.find((p) => `${p.module}.${p.action.toLowerCase()}` === key)?.sensitive;
const holders = (permission: string) => ROLE_TEMPLATES.filter((t) => holds(t.key, permission)).map((t) => t.key).sort();

describe("Phase 7 permission catalog", () => {
  it("defines the module.action keys", () => {
    expect(actions("background_jobs")).toEqual(["VIEW", "MANAGE"]);
    expect(actions("automation")).toEqual(["VIEW", "CONFIGURE", "APPROVE"]);
    expect(actions("integrations")).toEqual(["VIEW", "CONFIGURE", "MANAGE"]);
    expect(actions("payroll_exports")).toEqual(["VIEW", "CREATE", "APPROVE", "EXPORT"]);
    expect(actions("accounting_exports")).toEqual(["VIEW", "CREATE", "EXPORT", "APPROVE", "CONFIGURE"]);
  });

  it("marks configuration, approvals and exports as sensitive", () => {
    for (const key of [
      "automation.configure", "automation.approve", "integrations.configure", "payroll_exports.view", "payroll_exports.approve", "payroll_exports.export",
      "accounting_exports.view", "accounting_exports.export", "accounting_exports.approve", "accounting_exports.configure",
    ]) {
      expect(sensitive(key), key).toBe(true);
    }
    for (const key of ["background_jobs.view", "background_jobs.manage", "automation.view", "integrations.view", "integrations.manage"]) {
      expect(sensitive(key), key).toBe(false);
    }
    expect(customRoleRequiresMfa([{ permission: "integrations.configure" }])).toBe(true);
    expect(customRoleRequiresMfa([{ permission: "payroll_exports.export" }])).toBe(true);
    expect(customRoleRequiresMfa([{ permission: "automation.view" }, { permission: "integrations.view" }])).toBe(false);
  });
});

describe("Phase 7 role templates", () => {
  it("gives the Owner everything (configure and approve)", () => {
    expect(phase7Of("OWNER_CEO")).toEqual(
      PERMISSION_CATALOG.filter((p) => PHASE7_MODULES.includes(p.module)).map((p) => `${p.module}.${p.action.toLowerCase()}`).sort(),
    );
  });

  it("gives Finance accounting exports and mapping proposals, never their approval or payroll", () => {
    expect(phase7Of("FINANCE_DIRECTOR")).toEqual([
      "accounting_exports.configure", "accounting_exports.create", "accounting_exports.export", "accounting_exports.view",
    ]);
  });

  it("gives HR payroll (time facts) exports, never their release or anything financial", () => {
    expect(phase7Of("HR_MANAGER")).toEqual(["payroll_exports.create", "payroll_exports.export", "payroll_exports.view"]);
  });

  it("gives nobody else any Phase 7 permission", () => {
    for (const t of ROLE_TEMPLATES.filter((t) => !["OWNER_CEO", "FINANCE_DIRECTOR", "HR_MANAGER"].includes(t.key))) {
      expect(phase7Of(t.key), t.key).toEqual([]);
    }
  });

  it("keeps configuration and approvals with the Owner only", () => {
    for (const permission of ["automation.configure", "automation.approve", "integrations.configure", "background_jobs.manage", "payroll_exports.approve", "accounting_exports.approve"]) {
      expect(holders(permission), permission).toEqual(["OWNER_CEO"]);
    }
  });
});

describe("Phase 7 approval subjects and seeded policies", () => {
  const expected = {
    AUTOMATION_RULE_VERSION: "automation.approve",
    ACCOUNTING_MAPPING: "accounting_exports.approve",
    PAYROLL_EXPORT: "payroll_exports.approve",
  };

  it.each(Object.entries(expected))("%s has a subject type and a seeded policy approved by %s", (subject, permission) => {
    expect(APPROVAL_SUBJECT_TYPES).toContain(subject);
    const policy = APPROVAL_POLICY_SPECS.find((p) => p.subjectType === subject);
    expect(policy?.approverPermission).toBe(permission);
    expect(policy?.requiredApprovals).toBe(1);
  });
});

describe("Phase 7 labels exist in every catalog", () => {
  const families: Record<string, readonly string[]> = {
    "APPROVAL.SUBJECT.": ["AUTOMATION_RULE_VERSION", "ACCOUNTING_MAPPING", "PAYROLL_EXPORT"],
    "BACKGROUND_JOB.STATUS.": Object.values(BackgroundJobStatus),
    "AUTOMATION.RULE_STATUS.": Object.values(AutomationRuleStatus),
    "AUTOMATION.EXECUTION_RESULT.": Object.values(AutomationExecutionResult),
    "INTEGRATION.CATEGORY.": Object.values(IntegrationCategory),
    "INTEGRATION.STATUS.": Object.values(IntegrationStatus),
    "WEBHOOK.HANDLING_STATUS.": Object.values(WebhookHandlingStatus),
    "ACCOUNTING_MAPPING.STATUS.": Object.values(AccountingMappingStatus),
    "EXPORT_BATCH.KIND.": Object.values(ExportBatchKind),
    "EXPORT_BATCH.STATUS.": Object.values(ExportBatchStatus),
  };

  for (const [prefix, members] of Object.entries(families)) {
    it(`${prefix}*`, () => {
      for (const locale of SUPPORTED_LOCALES) {
        for (const member of members) expect(CATALOGS[locale].messages[`${prefix}${member}`], `${locale} ${prefix}${member}`).toBeTruthy();
      }
    });
  }

  it("has the payroll boundary and finance review notices", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of ["EXPORT_BATCH.PAYROLL_NOTICE", "EXPORT_BATCH.ACCOUNTING_NOTICE", "AUTOMATION.HIGH_IMPACT"]) {
        expect(CATALOGS[locale].messages[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});
