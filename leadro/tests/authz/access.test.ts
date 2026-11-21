import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertNotSelfApproval,
  can,
  canViewFields,
  explainAccess,
  PERMISSION_CATALOG,
  permissionKey,
} from "@/server/authz";
import { ForbiddenError } from "@/server/core";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, toActor, type World } from "./fixtures";

let w: World;

beforeAll(async () => {
  w = await buildWorld("authz-access");
});
afterAll(disconnect);

const HOUR = 3_600_000;

describe("spec 26.3 permission acceptance", () => {
  it("a City Manager cannot read another city's employees", async () => {
    const own = await can(w.cityManagerA.actor, "employees.view", { employeeId: w.techA1.employeeId! });
    expect(own).toMatchObject({ allowed: true, reason: "GRANTED" });

    const other = await can(w.cityManagerA.actor, "employees.view", { employeeId: w.techB.employeeId! });
    expect(other).toEqual({ allowed: false, reason: "OUT_OF_SCOPE", via: null });
  });

  it("scope covers descendants: a city manager reaches a team below the city", async () => {
    const decision = await can(w.cityManagerA.actor, "employees.view", { orgUnitId: w.units.teamA1 });
    expect(decision.allowed).toBe(true);
    expect(decision.via).toMatchObject({ scopeType: "ORG_UNIT", scopeOrgUnitId: w.units.cityA });
  });

  it("a Finance Director holds no dispatch, job-edit or organization permission", async () => {
    for (const key of ["dispatch.view", "dispatch.assign", "jobs.edit", "jobs.assign", "organization.edit"]) {
      expect(await can(w.finance.actor, key), key).toMatchObject({ allowed: false, reason: "NO_PERMISSION" });
    }
    expect((await can(w.finance.actor, "compensation.approve")).allowed).toBe(true);
  });

  it("a Technician cannot read another technician's profile, only their own", async () => {
    const own = await can(w.techA1.actor, "employees.view", { employeeId: w.techA1.employeeId! });
    expect(own.allowed).toBe(true);
    expect(own.via?.scopeType).toBe("OWN");

    // Same team, same city: still denied.
    const colleague = await can(w.techA1.actor, "employees.view", { employeeId: w.techA1Other.employeeId! });
    expect(colleague).toMatchObject({ allowed: false, reason: "OUT_OF_SCOPE" });
  });

  it("a Technician's compensation statement is only reachable by its owner", async () => {
    expect((await can(w.techA1.actor, "compensation.view", { ownerEmployeeId: w.techA1.employeeId! })).allowed).toBe(true);
    expect((await can(w.techA1.actor, "compensation.view", { ownerEmployeeId: w.techA1Other.employeeId! })).allowed).toBe(false);
  });

  it("a Technician reaches jobs assigned to them (ASSIGNED scope) and no others", async () => {
    const mine = await can(w.techA1.actor, "jobs.view", { assignedEmployeeIds: [w.techA1.employeeId!] });
    expect(mine.allowed).toBe(true);
    const notMine = await can(w.techA1.actor, "jobs.view", { assignedEmployeeIds: [w.techB.employeeId!] });
    expect(notMine.allowed).toBe(false);
  });

  it("a Dispatcher can never configure anything", async () => {
    const configureKeys = PERMISSION_CATALOG.filter((p) => p.action === "CONFIGURE").map(permissionKey);
    expect(configureKeys.length).toBeGreaterThan(0);
    for (const key of configureKeys) {
      expect(await can(w.dispatcher.actor, key), key).toMatchObject({ allowed: false, reason: "NO_PERMISSION" });
    }
    expect((await can(w.dispatcher.actor, "dispatch.assign")).allowed).toBe(true);
  });
});

describe("spec 25.5 re-evaluation on every request", () => {
  it("a temporary permission stops working when it expires, and not before it starts", async () => {
    const temp = await createPerson(w.tenantId, "temp", { withEmployee: false });
    const roleAssignmentId = await grantTemplate(
      w.tenantId,
      temp,
      w.roles.DISPATCHER,
      [{ type: "TENANT" }],
      { effectiveTo: new Date(Date.now() + HOUR) },
    );
    expect((await can(temp.actor, "dispatch.assign")).allowed).toBe(true);

    // The clock moves past effectiveTo: same row, same role, next request is denied.
    await withTenant(w.tenantId, (tx) =>
      tx.roleAssignment.update({
        where: { id: roleAssignmentId },
        data: { effectiveFrom: new Date(Date.now() - 2 * HOUR), effectiveTo: new Date(Date.now() - HOUR) },
      }),
    );
    expect(await can(temp.actor, "dispatch.assign")).toMatchObject({ allowed: false, reason: "NO_PERMISSION" });

    await withTenant(w.tenantId, (tx) =>
      tx.roleAssignment.update({
        where: { id: roleAssignmentId },
        data: { effectiveFrom: new Date(Date.now() + HOUR), effectiveTo: new Date(Date.now() + 2 * HOUR) },
      }),
    );
    expect((await can(temp.actor, "dispatch.assign")).allowed).toBe(false);
  });

  it("a revoked assignment grants nothing", async () => {
    const person = await createPerson(w.tenantId, "revoked", { withEmployee: false });
    const id = await grantTemplate(w.tenantId, person, w.roles.DISPATCHER, [{ type: "TENANT" }]);
    expect((await can(person.actor, "dispatch.view")).allowed).toBe(true);
    await withTenant(w.tenantId, (tx) => tx.roleAssignment.update({ where: { id }, data: { revokedAt: new Date() } }));
    expect((await can(person.actor, "dispatch.view")).allowed).toBe(false);
  });

  it("a manager who loses the org scope loses access on the next request", async () => {
    const manager = await createPerson(w.tenantId, "losing", { orgUnitId: w.units.cityA });
    const assignmentId = await grantTemplate(w.tenantId, manager, w.roles.CITY_MANAGER, [
      { type: "ORG_UNIT", orgUnitId: w.units.cityA },
    ]);
    const target = { employeeId: w.techA1.employeeId! };
    expect((await can(manager.actor, "employees.view", target)).allowed).toBe(true);

    await withTenant(w.tenantId, (tx) => tx.accessScope.deleteMany({ where: { roleAssignmentId: assignmentId } }));
    expect(await can(manager.actor, "employees.view", target)).toMatchObject({ allowed: false, reason: "NO_SCOPE" });
  });

  it("moving an org unit out of a manager's subtree removes access to it immediately", async () => {
    const world = await buildWorld("authz-reparent");
    const target = { employeeId: world.techB.employeeId! };
    expect((await can(world.stateManager.actor, "employees.view", target)).allowed).toBe(true);

    await withTenant(world.tenantId, (tx) =>
      tx.orgUnit.update({ where: { id: world.units.cityB }, data: { parentId: world.units.outside } }),
    );
    expect((await can(world.stateManager.actor, "employees.view", target)).allowed).toBe(false);
  });

  it("an archived org unit grants nothing, nor does its subtree", async () => {
    const world = await buildWorld("authz-archived");
    const target = { employeeId: world.techA1.employeeId! };
    expect((await can(world.cityManagerA.actor, "employees.view", target)).allowed).toBe(true);

    await withTenant(world.tenantId, (tx) => tx.orgUnit.update({ where: { id: world.units.cityA }, data: { active: false } }));
    expect((await can(world.cityManagerA.actor, "employees.view", target)).allowed).toBe(false);
    // The state manager's scope is still active but must not pass THROUGH the archived city.
    expect((await can(world.stateManager.actor, "employees.view", target)).allowed).toBe(false);
    // A tenant-wide grant is unaffected by archived units.
    expect((await can(world.ceo.actor, "employees.view", target)).allowed).toBe(true);
  });

  it("an employee who changes branch moves from one manager's scope to the other's", async () => {
    const world = await buildWorld("authz-move");
    const target = { employeeId: world.techA1.employeeId! };
    expect((await can(world.cityManagerA.actor, "employees.view", target)).allowed).toBe(true);
    expect((await can(world.cityManagerB.actor, "employees.view", target)).allowed).toBe(false);

    const hourAgo = new Date(Date.now() - HOUR);
    await withTenant(world.tenantId, async (tx) => {
      await tx.organizationalAssignment.updateMany({
        where: { employeeId: world.techA1.employeeId!, effectiveTo: null },
        data: { effectiveTo: hourAgo },
      });
      await tx.organizationalAssignment.create({
        data: { tenantId: world.tenantId, employeeId: world.techA1.employeeId!, orgUnitId: world.units.cityB, effectiveFrom: hourAgo },
      });
    });
    expect((await can(world.cityManagerA.actor, "employees.view", target)).allowed).toBe(false);
    expect((await can(world.cityManagerB.actor, "employees.view", target)).allowed).toBe(true);
  });

  it("a deactivated user or a terminated employee has no access at all", async () => {
    const world = await buildWorld("authz-inactive");
    expect((await can(world.ceo.actor, "employees.view")).allowed).toBe(true);

    await withTenant(world.tenantId, (tx) => tx.user.update({ where: { id: world.ceo.userId }, data: { status: "DEACTIVATED" } }));
    expect(await can(world.ceo.actor, "employees.view")).toMatchObject({ allowed: false, reason: "USER_NOT_ACTIVE" });

    expect((await can(world.cityManagerA.actor, "employees.view")).allowed).toBe(true);
    await withTenant(world.tenantId, (tx) =>
      tx.employee.update({ where: { id: world.cityManagerA.employeeId! }, data: { status: "TERMINATED" } }),
    );
    expect(await can(world.cityManagerA.actor, "employees.view")).toMatchObject({ allowed: false, reason: "USER_NOT_ACTIVE" });
  });
});

describe("tenant isolation and role names", () => {
  it("denies cross-tenant access even with forged ids, for a tenant-wide Owner", async () => {
    const other = await buildWorld("authz-other");
    // The other tenant's CEO is all-powerful at home...
    expect((await can(other.ceo.actor, "employees.view", { employeeId: other.techB.employeeId! })).allowed).toBe(true);
    // ...but ids of THIS tenant resolve to nothing for them, and vice versa.
    expect(await can(other.ceo.actor, "employees.view", { employeeId: w.techB.employeeId! })).toMatchObject({
      allowed: false,
      reason: "RESOURCE_NOT_FOUND",
    });
    expect(await can(w.ceo.actor, "organization.edit", { orgUnitId: other.units.cityA })).toMatchObject({
      allowed: false,
      reason: "RESOURCE_NOT_FOUND",
    });
    expect(await can(w.ceo.actor, "organization.edit", { legalEntityId: other.legalEntityId })).toMatchObject({
      reason: "RESOURCE_NOT_FOUND",
    });
  });

  it("denies a forged actor: a user id paired with another tenant's id", async () => {
    const forged = toActor(w.tenantId, (await buildWorld("authz-forge")).ceo.userId, null);
    expect(await can(forged, "employees.view")).toMatchObject({ allowed: false, reason: "USER_NOT_ACTIVE" });
  });

  it("a role named 'CEO' with no permissions grants nothing", async () => {
    const person = await createPerson(w.tenantId, "fake-ceo", { withEmployee: false });
    const roleId = await withTenant(w.tenantId, async (tx) => {
      const role = await tx.role.create({ data: { tenantId: w.tenantId, name: "CEO", templateKey: "OWNER_CEO" } });
      return role.id;
    });
    await grantTemplate(w.tenantId, person, roleId, [{ type: "TENANT" }]);

    for (const def of PERMISSION_CATALOG) {
      expect((await can(person.actor, permissionKey(def))).allowed, permissionKey(def)).toBe(false);
    }
  });

  it("denies unknown permission keys", async () => {
    expect(await can(w.ceo.actor, "employees.teleport")).toMatchObject({ allowed: false, reason: "UNKNOWN_PERMISSION" });
  });

  it("a tenant-level record (no org placement) needs a tenant-wide scope", async () => {
    expect((await can(w.ceo.actor, "customers.view", {})).allowed).toBe(true);
    expect(await can(w.cityManagerA.actor, "customers.view", {})).toMatchObject({ allowed: false, reason: "OUT_OF_SCOPE" });
  });
});

describe("conditions and sensitive fields", () => {
  it("a record-set qualifier only applies to records in that set", async () => {
    const inSet = await can(w.dispatcher.actor, "customers.view", { orgUnitId: w.units.cityA, sets: ["job_related"] });
    expect(inSet.allowed).toBe(true);
    const outOfSet = await can(w.dispatcher.actor, "customers.view", { orgUnitId: w.units.cityA, sets: [] });
    expect(outOfSet).toMatchObject({ allowed: false, reason: "CONDITION_NOT_MET" });
  });

  it("financial fields of employees: Owner, Finance and managers yes; HR, Dispatcher, Technician no", async () => {
    const target = { employeeId: w.techA1.employeeId! };
    const allowed = async (person: { actor: typeof w.ceo.actor }) =>
      (await canViewFields(person.actor, "employees.financial_fields", target)).allowed;

    expect(await allowed(w.ceo)).toBe(true);
    expect(await allowed(w.finance)).toBe(true);
    expect(await allowed(w.cityManagerA)).toBe(true);
    expect(await allowed(w.hr)).toBe(false); // HR sees employees, but not their financial fields
    expect(await allowed(w.dispatcher)).toBe(false); // availability only
    expect(await allowed(w.techA1Other)).toBe(false); // someone else's record
    expect((await can(w.hr.actor, "employees.view", target)).allowed).toBe(true);
  });

  it("billing fields of customers are visible to Finance but not to the Technician", async () => {
    expect((await canViewFields(w.finance.actor, "customers.billing_fields", {})).allowed).toBe(true);
    expect(
      (await canViewFields(w.techA1.actor, "customers.billing_fields", { assignedEmployeeIds: [w.techA1.employeeId!] })).allowed,
    ).toBe(false);
  });
});

describe("explainAccess", () => {
  it("names the role, assignment and scope that allow access", async () => {
    const result = await explainAccess(w.cityManagerA.actor, "employees.view", { employeeId: w.techA1.employeeId! });
    expect(result.decision.allowed).toBe(true);
    expect(result.summary).toContain("City Manager");
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].scopes[0]).toMatchObject({ matched: true, orgUnitId: w.units.cityA });
  });

  it("explains an out-of-scope denial and an expired grant", async () => {
    const outOfScope = await explainAccess(w.cityManagerA.actor, "employees.view", { employeeId: w.techB.employeeId! });
    expect(outOfScope.decision.reason).toBe("OUT_OF_SCOPE");
    expect(outOfScope.assignments[0].scopes[0]).toMatchObject({ matched: false });
    expect(outOfScope.assignments[0].scopes[0].detail).toMatch(/outside/i);

    const person = await createPerson(w.tenantId, "explain-expired", { withEmployee: false });
    await grantTemplate(w.tenantId, person, w.roles.DISPATCHER, [{ type: "TENANT" }]);
    await withTenant(w.tenantId, (tx) =>
      tx.roleAssignment.updateMany({
        where: { userId: person.userId },
        data: { effectiveFrom: new Date(Date.now() - 2 * HOUR), effectiveTo: new Date(Date.now() - HOUR) },
      }),
    );
    const expired = await explainAccess(person.actor, "dispatch.view");
    expect(expired.decision.reason).toBe("NO_PERMISSION");
    expect(expired.assignments[0]).toMatchObject({ status: "EXPIRED" });
  });

  it("reports an inactive account", async () => {
    const person = await createPerson(w.tenantId, "explain-locked", { withEmployee: false });
    await withTenant(w.tenantId, (tx) => tx.user.update({ where: { id: person.userId }, data: { status: "LOCKED" } }));
    const result = await explainAccess(person.actor, "dispatch.view");
    expect(result).toMatchObject({ accountActive: false, decision: { reason: "USER_NOT_ACTIVE" } });
  });
});

describe("separation of duties", () => {
  it("refuses self-approval and allows approving someone else's submission", () => {
    expect(() => assertNotSelfApproval("u1", "u1")).toThrow(ForbiddenError);
    expect(() => assertNotSelfApproval("u1", "u2")).not.toThrow();
    expect(() => assertNotSelfApproval("u1", null)).not.toThrow();
  });
});

describe("no caching across calls", () => {
  it("reflects a role change made directly in the database on the very next call", async () => {
    const person = await createPerson(w.tenantId, "nocache", { withEmployee: false });
    expect((await can(person.actor, "dispatch.view")).allowed).toBe(false);
    await grantTemplate(w.tenantId, person, w.roles.DISPATCHER, [{ type: "TENANT" }]);
    expect((await can(person.actor, "dispatch.view")).allowed).toBe(true);
  });
});
