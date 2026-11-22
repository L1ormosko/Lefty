import { describe, it, expect, afterAll } from "vitest";
import {
  isMfaTriggeringPermission,
  isPermissionKey,
  provisionRoleTemplates,
  ROLE_TEMPLATES,
  templateRequiresMfa,
} from "@/server/authz";
import { ConflictError } from "@/server/core";
import { prisma, withTenant } from "@/server/db";
import { createTenant } from "../helpers";

afterAll(async () => {
  await prisma.$disconnect();
});

const template = (key: string) => {
  const found = ROLE_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new Error(`no template ${key}`);
  return found;
};
const holds = (key: string, permission: string) => template(key).grants.some((g) => g.permission === permission);

describe("role template definitions", () => {
  it("covers the twelve spec 4.4 roles with unique keys and names", () => {
    expect(ROLE_TEMPLATES).toHaveLength(12);
    expect(new Set(ROLE_TEMPLATES.map((t) => t.key)).size).toBe(12);
    expect(new Set(ROLE_TEMPLATES.map((t) => t.name)).size).toBe(12);
  });

  it("only references permissions that exist in the catalog, once each", () => {
    for (const t of ROLE_TEMPLATES) {
      const keys = t.grants.map((g) => g.permission);
      expect(keys.every(isPermissionKey), t.key).toBe(true);
      expect(new Set(keys).size, `${t.key} has duplicate grants`).toBe(keys.length);
    }
  });

  it("marks Owner/CEO, Finance Director and HR Manager as requiring MFA", () => {
    for (const key of ["OWNER_CEO", "FINANCE_DIRECTOR", "HR_MANAGER"]) expect(template(key).requiresMfa, key).toBe(true);
  });

  it("requires MFA for every template holding permissions.manage/assign or any configure permission", () => {
    for (const t of ROLE_TEMPLATES) {
      const triggering = t.grants.some((g) => isMfaTriggeringPermission(g.permission));
      if (triggering) expect(t.requiresMfa, t.key).toBe(true);
    }
    expect(template("COO").requiresMfa).toBe(true); // holds permissions.assign
  });

  it("leaves operational roles without MFA by default", () => {
    for (const key of ["DISPATCHER", "TECHNICIAN", "CITY_MANAGER", "STATE_MANAGER", "TEAM_LEADER", "CUSTOMER_RELATIONS"]) {
      expect(template(key).requiresMfa, key).toBe(false);
    }
  });

  it("applies the MFA rule to a custom grant list regardless of the name", () => {
    expect(templateRequiresMfa("CUSTOM", [{ permission: "permissions.manage" }])).toBe(true);
    expect(templateRequiresMfa("CUSTOM", [{ permission: "localization.configure" }])).toBe(true);
    expect(templateRequiresMfa("CUSTOM", [{ permission: "jobs.view" }])).toBe(false);
  });

  it("hands out sensitive field sets only to Owner/CEO and Finance Director (opt-in)", () => {
    const naming = ROLE_TEMPLATES.filter((t) =>
      t.grants.some((g) => g.conditions?.includeFields?.length || ["financial", "billing"].includes(g.conditions?.fields ?? "")),
    ).map((t) => t.key);
    expect(naming.sort()).toEqual(["FINANCE_DIRECTOR", "OWNER_CEO"]);
  });

  it("gives the Technician no financial_reports permission", () => {
    expect(holds("TECHNICIAN", "financial_reports.view")).toBe(false);
    expect(holds("TECHNICIAN", "compensation.view")).toBe(true);
  });

  it("follows the 4.5 matrix for the separation-critical cells", () => {
    // Finance does not gain operational management (spec 4.4).
    for (const p of ["dispatch.view", "jobs.edit", "organization.view", "leads.view"]) expect(holds("FINANCE_DIRECTOR", p), p).toBe(false);
    expect(holds("FINANCE_DIRECTOR", "compensation.configure")).toBe(true);
    // Dispatcher has dispatch.* but nothing financial or configurable.
    expect(holds("DISPATCHER", "dispatch.manage")).toBe(true);
    expect(holds("DISPATCHER", "compensation.view")).toBe(false);
    expect(ROLE_TEMPLATES.find((t) => t.key === "DISPATCHER")!.grants.some((g) => g.permission.endsWith(".configure"))).toBe(false);
    // Only the Owner configures company settings.
    expect(holds("COO", "company_settings.edit")).toBe(true);
    expect(holds("COO", "company_settings.configure")).toBe(false);
    // Lead Ops: leads.* except archive.
    expect(holds("LEAD_OPERATIONS_MANAGER", "leads.assign")).toBe(true);
    expect(holds("LEAD_OPERATIONS_MANAGER", "leads.archive")).toBe(false);
    // Technician is own/assigned only, with no export or management.
    expect(template("TECHNICIAN").suggestedScopeTypes).toEqual(["OWN", "ASSIGNED"]);
    expect(template("TECHNICIAN").grants.some((g) => /\.(export|manage|configure|archive|approve)$/.test(g.permission))).toBe(false);
  });
});

describe("Phase 2 matrix rows (Customers, Leads, Dispatch, Jobs) and the new modules", () => {
  const grant = (key: string, permission: string) => template(key).grants.find((g) => g.permission === permission);

  it("Dispatcher has the full dispatch module, operational jobs and read-only qualifications, with nothing financial or configurable", () => {
    for (const action of ["view", "create", "edit", "assign", "manage"]) expect(holds("DISPATCHER", `dispatch.${action}`), action).toBe(true);
    for (const action of ["view", "create", "edit", "assign"]) expect(grant("DISPATCHER", `jobs.${action}`)?.conditions, action).toBeUndefined();
    expect(holds("DISPATCHER", "jobs.archive")).toBe(false);
    expect(holds("DISPATCHER", "qualifications.view")).toBe(true);
    expect(holds("DISPATCHER", "qualifications.edit")).toBe(false);
    expect(holds("DISPATCHER", "job_types.view")).toBe(true);
    expect(holds("DISPATCHER", "job_types.configure")).toBe(false);
  });

  it("Lead Operations Manager has every lead action except archive, plus lead sources (leads.manage)", () => {
    for (const action of ["view", "create", "edit", "assign", "export", "manage"]) expect(holds("LEAD_OPERATIONS_MANAGER", `leads.${action}`), action).toBe(true);
    expect(holds("LEAD_OPERATIONS_MANAGER", "leads.archive")).toBe(false);
    expect(template("LEAD_OPERATIONS_MANAGER").requiresMfa).toBe(false);
  });

  it("Technician sees assigned work and may change only execution / status fields", () => {
    expect(grant("TECHNICIAN", "jobs.view")?.conditions).toBeUndefined();
    expect(grant("TECHNICIAN", "jobs.edit")?.conditions).toEqual({ fields: "execution" });
    expect(grant("TECHNICIAN", "leads.edit")?.conditions).toEqual({ fields: "status" });
    for (const permission of ["jobs.create", "jobs.assign", "dispatch.assign", "customers.edit", "leads.assign", "qualifications.edit"]) {
      expect(holds("TECHNICIAN", permission), permission).toBe(false);
    }
    // Plain grants never include the opt-in financial / billing sets.
    expect(template("TECHNICIAN").grants.some((g) => g.conditions?.includeFields?.length)).toBe(false);
  });

  it("Customer Relations manages customers in scope and reads job history only through the customer history set", () => {
    for (const action of ["view", "create", "edit"]) expect(holds("CUSTOMER_RELATIONS", `customers.${action}`), action).toBe(true);
    expect(holds("CUSTOMER_RELATIONS", "customers.archive")).toBe(false);
    expect(grant("CUSTOMER_RELATIONS", "jobs.view")?.conditions).toEqual({ set: "customer_history" });
    expect(holds("CUSTOMER_RELATIONS", "jobs.edit")).toBe(false);
  });

  it("every template reads and manages its own notifications; only HR/Owner/managers touch qualifications", () => {
    for (const t of ROLE_TEMPLATES) {
      expect(holds(t.key, "notifications.view"), t.key).toBe(true);
      expect(holds(t.key, "notifications.edit"), t.key).toBe(true);
    }
    expect(holds("HR_MANAGER", "qualifications.approve")).toBe(true);
    expect(holds("CITY_MANAGER", "qualifications.edit")).toBe(true);
    expect(holds("CITY_MANAGER", "qualifications.approve")).toBe(false);
    expect(holds("FINANCE_DIRECTOR", "qualifications.view")).toBe(false);
  });

  it("job_types.configure is held by Owner and COO only, so those roles require MFA", () => {
    const holders = ROLE_TEMPLATES.filter((t) => holds(t.key, "job_types.configure")).map((t) => t.key).sort();
    expect(holders).toEqual(["COO", "OWNER_CEO"]);
    for (const key of holders) expect(template(key).requiresMfa, key).toBe(true);
  });
});

describe("provisionRoleTemplates", () => {
  it("creates every template as an editable role with its permissions, conditions and MFA flag", async () => {
    const tenant = await createTenant("authz-tpl");
    const roleIds = await withTenant(tenant.id, (tx) => provisionRoleTemplates(tx, tenant.id));
    expect(Object.keys(roleIds).sort()).toEqual(ROLE_TEMPLATES.map((t) => t.key).sort());

    const roles = await withTenant(tenant.id, (tx) =>
      tx.role.findMany({ include: { permissions: { include: { permission: true } } } }),
    );
    expect(roles).toHaveLength(12);
    for (const role of roles) {
      const def = template(role.templateKey!);
      expect(role).toMatchObject({ name: def.name, isSystemTemplate: true, requiresMfa: def.requiresMfa, active: true });
      expect(role.permissions.map((p) => p.permission.key).sort()).toEqual(def.grants.map((g) => g.permission).sort());
    }
    const financeEmployees = roles
      .find((r) => r.templateKey === "FINANCE_DIRECTOR")!
      .permissions.find((p) => p.permission.key === "employees.view");
    expect(financeEmployees?.conditions).toEqual({ fields: "financial" });
  });

  it("is idempotent and never overwrites a tenant's edits", async () => {
    const tenant = await createTenant("authz-tpl-idem");
    const first = await withTenant(tenant.id, (tx) => provisionRoleTemplates(tx, tenant.id));
    await withTenant(tenant.id, (tx) =>
      tx.rolePermission.deleteMany({ where: { roleId: first.DISPATCHER, permission: { key: "dispatch.manage" } } }),
    );
    const second = await withTenant(tenant.id, (tx) => provisionRoleTemplates(tx, tenant.id));
    expect(second).toEqual(first);
    expect(await withTenant(tenant.id, (tx) => tx.role.count())).toBe(12);
    const stillRemoved = await withTenant(tenant.id, (tx) =>
      tx.rolePermission.count({ where: { roleId: first.DISPATCHER, permission: { key: "dispatch.manage" } } }),
    );
    expect(stillRemoved).toBe(0);
  });

  it("refuses to adopt an unrelated role that already uses a template's name", async () => {
    const tenant = await createTenant("authz-tpl-clash");
    await withTenant(tenant.id, (tx) => tx.role.create({ data: { tenantId: tenant.id, name: "Dispatcher" } }));
    await expect(withTenant(tenant.id, (tx) => provisionRoleTemplates(tx, tenant.id))).rejects.toBeInstanceOf(ConflictError);
  });

  it("keeps tenants separate: each tenant gets its own roles", async () => {
    const a = await createTenant("authz-tpl-a");
    const b = await createTenant("authz-tpl-b");
    const rolesA = await withTenant(a.id, (tx) => provisionRoleTemplates(tx, a.id));
    const rolesB = await withTenant(b.id, (tx) => provisionRoleTemplates(tx, b.id));
    expect(rolesA.DISPATCHER).not.toBe(rolesB.DISPATCHER);
    expect(await withTenant(a.id, (tx) => tx.role.count({ where: { id: rolesB.DISPATCHER } }))).toBe(0);
  });
});
