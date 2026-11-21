import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { employeeScopeColumns, orgUnitScopeColumns, scopeFilter } from "@/server/authz";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, type World } from "./fixtures";

let w: World;

beforeAll(async () => {
  w = await buildWorld("authz-scope");
});
afterAll(disconnect);

/** Runs a list query the way a service would: scope fragment from the engine, executed under RLS. */
async function visibleEmployeeIds(actor: World["ceo"]["actor"], permission = "employees.view"): Promise<string[]> {
  const where = await scopeFilter(actor, permission, employeeScopeColumns);
  const rows = await withTenant(actor.tenantId, (tx) => tx.employee.findMany({ where, select: { id: true } }));
  return rows.map((row) => row.id).sort();
}

const ids = (...people: Array<{ employeeId: string | null }>) => people.map((p) => p.employeeId!).sort();

describe("scopeFilter over employees", () => {
  it("a City Manager sees their city's subtree (including descendants) and nobody else", async () => {
    expect(await visibleEmployeeIds(w.cityManagerA.actor)).toEqual(ids(w.cityManagerA, w.techA1, w.techA1Other));
  });

  it("a State Manager sees every city below the state", async () => {
    expect(await visibleEmployeeIds(w.stateManager.actor)).toEqual(
      ids(w.stateManager, w.cityManagerA, w.cityManagerB, w.dispatcher, w.techA1, w.techA1Other, w.techB),
    );
  });

  it("a tenant-wide Owner gets an unrestricted fragment but still only their tenant's rows", async () => {
    expect(await scopeFilter(w.ceo.actor, "employees.view", employeeScopeColumns)).toEqual({});
    expect(await visibleEmployeeIds(w.ceo.actor)).toEqual(
      ids(w.stateManager, w.cityManagerA, w.cityManagerB, w.dispatcher, w.techA1, w.techA1Other, w.techB),
    );
  });

  it("a Technician (OWN scope) sees only themselves", async () => {
    expect(await visibleEmployeeIds(w.techA1.actor)).toEqual(ids(w.techA1));
  });

  it("a user with no grant gets a fragment that matches nothing", async () => {
    expect(await scopeFilter(w.finance.actor, "dispatch.view", employeeScopeColumns)).toEqual({ OR: [] });
    expect(await visibleEmployeeIds(w.finance.actor, "dispatch.view")).toEqual([]);
  });

  it("archived units drop out of the filter, and so do their employees", async () => {
    const world = await buildWorld("authz-scope-arch");
    await withTenant(world.tenantId, (tx) => tx.orgUnit.update({ where: { id: world.units.teamA1 }, data: { active: false } }));
    const where = await scopeFilter(world.cityManagerA.actor, "employees.view", employeeScopeColumns);
    const rows = await withTenant(world.tenantId, (tx) => tx.employee.findMany({ where, select: { id: true } }));
    expect(rows.map((r) => r.id).sort()).toEqual(ids(world.cityManagerA));
  });

  it("includeDescendants = false limits the scope to the unit itself", async () => {
    const world = await buildWorld("authz-scope-exact");
    const person = await createPerson(world.tenantId, "exact", { withEmployee: false });
    await grantTemplate(world.tenantId, person, world.roles.CITY_MANAGER, [
      { type: "ORG_UNIT", orgUnitId: world.units.cityA, includeDescendants: false },
    ]);
    const where = await scopeFilter(person.actor, "employees.view", employeeScopeColumns);
    const rows = await withTenant(world.tenantId, (tx) => tx.employee.findMany({ where, select: { id: true } }));
    expect(rows.map((r) => r.id)).toEqual([world.cityManagerA.employeeId]);
  });

  it("an expired assignment contributes no scope", async () => {
    const world = await buildWorld("authz-scope-exp");
    await withTenant(world.tenantId, (tx) =>
      tx.roleAssignment.updateMany({
        where: { userId: world.cityManagerA.userId },
        data: { effectiveFrom: new Date(Date.now() - 7_200_000), effectiveTo: new Date(Date.now() - 3_600_000) },
      }),
    );
    expect(await scopeFilter(world.cityManagerA.actor, "employees.view", employeeScopeColumns)).toEqual({ OR: [] });
  });

  it("a LEGAL_ENTITY scope selects by legal employer", async () => {
    const world = await buildWorld("authz-scope-le");
    const person = await createPerson(world.tenantId, "le", { withEmployee: false });
    await grantTemplate(world.tenantId, person, world.roles.HR_MANAGER, [
      { type: "LEGAL_ENTITY", legalEntityId: world.legalEntityId },
    ]);
    const where = await scopeFilter(person.actor, "employees.view", employeeScopeColumns);
    const rows = await withTenant(world.tenantId, (tx) => tx.employee.findMany({ where, select: { id: true } }));
    // Every fixture employee with a person-record has the company as legal employer.
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });

  it("set-qualified grants are ignored unless the caller states it already restricts to that set", async () => {
    const without = await scopeFilter(w.dispatcher.actor, "customers.view", orgUnitScopeColumns);
    expect(without).toEqual({ OR: [] });
    const withSet = await scopeFilter(w.dispatcher.actor, "customers.view", orgUnitScopeColumns, {
      satisfiedSets: ["job_related"],
    });
    expect(withSet).toMatchObject({ OR: [{ id: { in: expect.arrayContaining([w.units.cityA, w.units.teamA1]) } }] });
  });
});
