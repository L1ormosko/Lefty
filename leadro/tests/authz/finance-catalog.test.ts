import { describe, expect, it } from "vitest";
import { isPermissionKey, PERMISSION_CATALOG, ROLE_TEMPLATES, SENSITIVE_FIELD_CATEGORIES } from "@/server/authz";
import { APPROVAL_POLICY_SPECS } from "../../prisma/seed/finance-specs";

const FINANCE_MODULES = [
  "finance_ledger", "finance_payments", "finance_refunds", "finance_chargebacks", "finance_adjustments", "finance_reconciliation",
];
const template = (key: string) => {
  const found = ROLE_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new Error(`no template ${key}`);
  return found;
};
const holds = (key: string, permission: string) => template(key).grants.some((g) => g.permission === permission);
const modulesOf = (key: string) => new Set(template(key).grants.map((g) => g.permission.split(".")[0]));

describe("Phase 4 permission catalog", () => {
  it("adds materials, finance and approvals modules with the documented actions", () => {
    const actions = (module: string) => PERMISSION_CATALOG.filter((p) => p.module === module).map((p) => p.action);
    expect(actions("materials")).toEqual(["VIEW", "CREATE", "EDIT", "ARCHIVE", "APPROVE", "EXPORT"]);
    expect(actions("finance_ledger")).toEqual(["VIEW", "EXPORT"]);
    expect(actions("approvals")).toEqual(["VIEW", "MANAGE", "CONFIGURE"]);
    for (const module of FINANCE_MODULES) expect(actions(module).length, module).toBeGreaterThan(0);
  });

  it("marks money-moving and ledger-reading permissions sensitive", () => {
    const sensitive = (key: string) => PERMISSION_CATALOG.find((p) => `${p.module}.${p.action.toLowerCase()}` === key)?.sensitive;
    for (const key of ["finance_ledger.view", "finance_ledger.export", "finance_payments.create", "finance_refunds.approve", "finance_adjustments.approve", "approvals.configure", "materials.approve"]) {
      expect(sensitive(key), key).toBe(true);
    }
    expect(sensitive("materials.view")).toBe(false);
  });

  it("has a `cost` field set for materials", () => {
    expect(SENSITIVE_FIELD_CATEGORIES.find((c) => c.key === "materials.cost_fields")?.tag).toBe("cost");
  });

  it("every seeded approval policy names an approver permission that exists", () => {
    for (const spec of APPROVAL_POLICY_SPECS) expect(isPermissionKey(spec.approverPermission), spec.code).toBe(true);
  });
});

describe("Phase 4 role templates", () => {
  it("gives the Owner every new permission", () => {
    for (const p of PERMISSION_CATALOG.filter((x) => x.module.startsWith("finance_") || x.module === "materials" || x.module === "approvals")) {
      expect(holds("OWNER_CEO", `${p.module}.${p.action.toLowerCase()}`), `${p.module}.${p.action}`).toBe(true);
    }
  });

  it("gives the Finance Director full finance and policy configuration but nothing operational", () => {
    for (const module of FINANCE_MODULES) {
      for (const p of PERMISSION_CATALOG.filter((x) => x.module === module)) expect(holds("FINANCE_DIRECTOR", `${module}.${p.action.toLowerCase()}`), `${module}.${p.action}`).toBe(true);
    }
    expect(holds("FINANCE_DIRECTOR", "approvals.configure")).toBe(true);
    expect(holds("FINANCE_DIRECTOR", "materials.approve")).toBe(true);
    for (const p of ["materials.create", "materials.edit", "dispatch.view", "jobs.edit", "jobs.assign", "employees.edit", "organization.view", "shifts.view"]) {
      expect(holds("FINANCE_DIRECTOR", p), p).toBe(false);
    }
    expect(template("FINANCE_DIRECTOR").requiresMfa).toBe(true);
    expect(template("FINANCE_DIRECTOR").grants.find((g) => g.permission === "materials.view")?.conditions).toEqual({ includeFields: ["cost"] });
  });

  it("limits managers to scoped views and requests: no approving, recording, exporting or configuring money", () => {
    for (const key of ["STATE_MANAGER", "REGIONAL_MANAGER", "CITY_MANAGER"]) {
      for (const p of ["finance_ledger.view", "finance_payments.view", "finance_refunds.create", "finance_adjustments.create", "finance_reconciliation.view", "approvals.view"]) {
        expect(holds(key, p), `${key} ${p}`).toBe(true);
      }
      for (const p of ["finance_refunds.approve", "finance_adjustments.approve", "finance_payments.create", "finance_ledger.export", "approvals.configure", "materials.approve"]) {
        expect(holds(key, p), `${key} ${p}`).toBe(false);
      }
      expect(template(key).grants.find((g) => g.permission === "materials.view")?.conditions).toBeUndefined();
    }
  });

  it("only Owner and Finance Director see material costs or decide money", () => {
    const costNaming = ROLE_TEMPLATES.filter((t) => t.grants.some((g) => g.permission.startsWith("materials.") && g.conditions?.includeFields?.includes("cost"))).map((t) => t.key);
    expect(costNaming.sort()).toEqual(["FINANCE_DIRECTOR", "OWNER_CEO"]);
    const deciders = ROLE_TEMPLATES.filter((t) => t.grants.some((g) => /^finance_(refunds|adjustments|chargebacks)\.approve$/.test(g.permission))).map((t) => t.key);
    expect(deciders.sort()).toEqual(["FINANCE_DIRECTOR", "OWNER_CEO"]);
  });

  it("gives Technician, Dispatcher and Team Leader material names only, and Lead Ops, HR and Customer Relations nothing", () => {
    for (const key of ["TECHNICIAN", "DISPATCHER", "TEAM_LEADER"]) {
      expect(holds(key, "materials.view"), key).toBe(true);
      expect(template(key).grants.find((g) => g.permission === "materials.view")?.conditions, key).toBeUndefined();
      expect([...modulesOf(key)].filter((m) => m.startsWith("finance_") || m === "approvals"), key).toEqual([]);
    }
    for (const key of ["LEAD_OPERATIONS_MANAGER", "HR_MANAGER", "CUSTOMER_RELATIONS"]) {
      expect([...modulesOf(key)].filter((m) => m.startsWith("finance_") || m === "approvals" || m === "materials"), key).toEqual([]);
    }
  });
});
