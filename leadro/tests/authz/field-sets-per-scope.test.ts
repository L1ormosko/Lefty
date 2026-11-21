import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assignRole,
  CUSTOMER_FIELD_MAP,
  EMPLOYEE_FIELD_MAP,
  employeeRowAttributes,
  employeeScopeColumns,
  employeeScopeSelect,
  fieldSetsForRow,
  projectFields,
  projectRows,
  resolveScope,
  scopeFilterInTx,
  SENSITIVE_FIELD_CATEGORIES,
} from "@/server/authz";
import { ForbiddenError } from "@/server/core";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type World } from "./fixtures";

let w: World;

beforeAll(async () => {
  w = await buildWorld("authz-fieldsets");
});
afterAll(disconnect);

describe("field sets are tracked per scope part (list routes)", () => {
  it("a financial-only grant on City A does not leak financial fields into City B rows", async () => {
    const financialRole = await makeRole(w.tenantId, "Employees financial", [
      { permission: "employees.view", conditions: { fields: "financial" } },
    ]);
    const plainRole = await makeRole(w.tenantId, "Employees plain", [{ permission: "employees.view" }]);
    const person = await createPerson(w.tenantId, "mixed-viewer", { withEmployee: false });
    await grantTemplate(w.tenantId, person, financialRole, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    await grantTemplate(w.tenantId, person, plainRole, [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }]);

    const { scope, rows } = await withTenant(w.tenantId, async (tx) => {
      const scope = await resolveScope(tx, person.actor, "employees.view");
      const where = await scopeFilterInTx(tx, person.actor, "employees.view", employeeScopeColumns);
      const fetched = await tx.employee.findMany({
        where,
        select: { ...employeeScopeSelect(), firstName: true },
      });
      // Reserved pay column stands in for the real one (none exists in the Phase 1 schema).
      return { scope, rows: fetched.map((row) => ({ ...row, salary: 100 })) };
    });

    const inCityA = [w.cityManagerA, w.techA1, w.techA1Other].map((p) => p.employeeId!);
    const inCityB = [w.cityManagerB, w.techB].map((p) => p.employeeId!);
    expect(rows.map((r) => r.id).sort()).toEqual([...inCityA, ...inCityB].sort());

    const projected = projectRows(rows, scope, EMPLOYEE_FIELD_MAP, employeeRowAttributes);
    for (const [index, row] of rows.entries()) {
      if (inCityA.includes(row.id)) {
        expect(projected[index], "city A row").toEqual({ salary: 100 });
      } else {
        expect(projected[index], "city B row").toEqual({ id: row.id, legalEntityId: row.legalEntityId, firstName: row.firstName });
        expect(projected[index]).not.toHaveProperty("salary");
      }
    }

    // The single-record path agrees (can() is per matched scope already).
    expect(fieldSetsForRow(scope, { orgUnitIds: [w.units.cityB] })).toEqual(["base"]);
    expect(fieldSetsForRow(scope, { orgUnitIds: [w.units.cityA] })).toEqual(["financial"]);
    expect(fieldSetsForRow(scope, { orgUnitIds: [w.units.outside] })).toEqual([]);
  });

  it("a grant scoped only to an archived unit contributes no scope and no field sets", async () => {
    const world = await buildWorld("authz-fieldsets-arch");
    const financialRole = await makeRole(world.tenantId, "Employees financial", [
      { permission: "employees.view", conditions: { includeFields: ["financial"] } },
    ]);
    const plainRole = await makeRole(world.tenantId, "Employees plain", [{ permission: "employees.view" }]);
    const person = await createPerson(world.tenantId, "archived-viewer", { withEmployee: false });
    await grantTemplate(world.tenantId, person, financialRole, [{ type: "ORG_UNIT", orgUnitId: world.units.cityA }]);
    await grantTemplate(world.tenantId, person, plainRole, [{ type: "ORG_UNIT", orgUnitId: world.units.cityB }]);
    await withTenant(world.tenantId, (tx) => tx.orgUnit.update({ where: { id: world.units.cityA }, data: { active: false } }));

    const scope = await withTenant(world.tenantId, (tx) => resolveScope(tx, person.actor, "employees.view"));
    expect(scope.parts).toHaveLength(1);
    expect(scope.parts[0].fieldSets).toEqual(["base"]);
    expect(fieldSetsForRow(scope, { orgUnitIds: [world.units.cityA] })).toEqual([]);
  });
});

describe("field maps", () => {
  it("drops unmapped fields and requires every non-base tag to be a known sensitive tag", () => {
    const decision = { allowed: true, fieldSets: ["base", "financial"] };
    expect(projectFields({ firstName: "A", salary: 1, brandNewColumn: "x" }, decision, EMPLOYEE_FIELD_MAP)).toEqual({
      firstName: "A",
      salary: 1,
    });
    expect(projectFields({ toString: 1, constructor: 2 }, decision, EMPLOYEE_FIELD_MAP)).toEqual({});

    const tags = new Set<string>(SENSITIVE_FIELD_CATEGORIES.map((c) => c.tag));
    for (const map of [EMPLOYEE_FIELD_MAP, CUSTOMER_FIELD_MAP]) {
      for (const tag of new Set(Object.values(map))) expect(tag === "base" || tags.has(tag), tag).toBe(true);
    }
    expect(Object.entries(EMPLOYEE_FIELD_MAP).filter(([, tag]) => tag === "financial").length).toBeGreaterThan(0);
  });
});

describe("anti-escalation covers scope and field sets together", () => {
  const grantTo = (granter: Awaited<ReturnType<typeof createPerson>>, userId: string, roleId: string, scopes: Parameters<typeof grantTemplate>[3]) =>
    withTenant(w.tenantId, (tx) => assignRole(tx, granter.actor, { userId, roleId, scopes }));

  it("financial on City A plus plain on the tenant cannot hand out financial at tenant scope", async () => {
    const assignRoleId = await makeRole(w.tenantId, "Assigner", [{ permission: "permissions.assign" }]);
    const financialRole = await makeRole(w.tenantId, "Jobs financial held", [
      { permission: "jobs.view", conditions: { includeFields: ["financial"] } },
    ]);
    const plainRole = await makeRole(w.tenantId, "Jobs plain held", [{ permission: "jobs.view" }]);
    const granter = await createPerson(w.tenantId, "split-granter", { withEmployee: false });
    await grantTemplate(w.tenantId, granter, assignRoleId, [{ type: "TENANT" }]);
    await grantTemplate(w.tenantId, granter, financialRole, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    await grantTemplate(w.tenantId, granter, plainRole, [{ type: "TENANT" }]);

    const toHand = await makeRole(w.tenantId, "Jobs financial to hand", [
      { permission: "jobs.view", conditions: { includeFields: ["financial"] } },
    ]);
    const recipient = async () => (await createPerson(w.tenantId, "recipient", { withEmployee: false })).userId;

    await expect(grantTo(granter, await recipient(), toHand, [{ type: "TENANT" }])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      grantTo(granter, await recipient(), toHand, [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Where the financial grant itself reaches, it may be delegated.
    await expect(
      grantTo(granter, await recipient(), toHand, [{ type: "ORG_UNIT", orgUnitId: w.units.teamA1 }]),
    ).resolves.toBeDefined();
  });

  it("a financial grant whose only scope is an archived unit no longer counts", async () => {
    const world = await buildWorld("authz-esc-arch");
    const assignRoleId = await makeRole(world.tenantId, "Assigner", [{ permission: "permissions.assign" }]);
    const financialRole = await makeRole(world.tenantId, "Jobs financial held", [
      { permission: "jobs.view", conditions: { includeFields: ["financial"] } },
    ]);
    const plainRole = await makeRole(world.tenantId, "Jobs plain held", [{ permission: "jobs.view" }]);
    const granter = await createPerson(world.tenantId, "archived-granter", { withEmployee: false });
    await grantTemplate(world.tenantId, granter, assignRoleId, [{ type: "TENANT" }]);
    await grantTemplate(world.tenantId, granter, financialRole, [{ type: "ORG_UNIT", orgUnitId: world.units.cityA }]);
    await grantTemplate(world.tenantId, granter, plainRole, [{ type: "TENANT" }]);
    const toHand = await makeRole(world.tenantId, "Jobs financial to hand", [
      { permission: "jobs.view", conditions: { includeFields: ["financial"] } },
    ]);
    const request = async () => {
      const recipient = await createPerson(world.tenantId, "recipient", { withEmployee: false });
      return withTenant(world.tenantId, (tx) =>
        assignRole(tx, granter.actor, { userId: recipient.userId, roleId: toHand, scopes: [{ type: "ORG_UNIT", orgUnitId: world.units.teamA1 }] }),
      );
    };
    await expect(request()).resolves.toBeDefined();
    await withTenant(world.tenantId, (tx) => tx.orgUnit.update({ where: { id: world.units.cityA }, data: { active: false } }));
    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
