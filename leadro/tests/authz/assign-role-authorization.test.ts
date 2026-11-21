import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { assignRole, can } from "@/server/authz";
import type { ActorAssignRoleInput } from "@/server/authz";
import { ForbiddenError } from "@/server/core";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type Person, type World } from "./fixtures";

let w: World;

beforeAll(async () => {
  w = await buildWorld("authz-escalation");
});
afterAll(disconnect);

const grantAs = (granter: Person, input: ActorAssignRoleInput) =>
  withTenant(w.tenantId, (tx) => assignRole(tx, granter.actor, input));

const target = () => createPerson(w.tenantId, "target", { withEmployee: false });

/** A delegated admin: may assign roles inside City A, and holds jobs.view (base fields) there. */
async function cityAAdmin(): Promise<Person> {
  const roleId = await makeRole(w.tenantId, "City A admin", [
    { permission: "permissions.assign" },
    { permission: "jobs.view" },
  ]);
  const admin = await createPerson(w.tenantId, "admin-a", { withEmployee: false });
  await grantTemplate(w.tenantId, admin, roleId, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
  return admin;
}

describe("assignRole (actor-checked)", () => {
  it("lets a tenant-wide Owner grant any role, e.g. Dispatcher with an org scope, and records them as granter", async () => {
    const person = await target();
    const { roleAssignmentId } = await grantAs(w.ceo, {
      userId: person.userId,
      roleId: w.roles.DISPATCHER,
      scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }],
    });
    const row = await withTenant(w.tenantId, (tx) => tx.roleAssignment.findUniqueOrThrow({ where: { id: roleAssignmentId } }));
    expect(row.grantedById).toBe(w.ceo.userId);
    expect((await can(person.actor, "dispatch.assign")).allowed).toBe(true);
  });

  it("refuses a user without permissions.assign", async () => {
    await expect(
      grantAs(w.cityManagerA, { userId: (await target()).userId, roleId: w.roles.TEAM_LEADER, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses granting a role to oneself (separation of duties), even for an Owner", async () => {
    await expect(
      grantAs(w.ceo, { userId: w.ceo.userId, roleId: w.roles.FINANCE_DIRECTOR, scopes: [{ type: "TENANT" }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await cityAAdmin();
    const role = await makeRole(w.tenantId, "Jobs viewer", [{ permission: "jobs.view" }]);
    await expect(
      grantAs(admin, { userId: admin.userId, roleId: role, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only lets a scoped admin grant within the scopes they hold", async () => {
    const admin = await cityAAdmin();
    const role = await makeRole(w.tenantId, "Jobs viewer", [{ permission: "jobs.view" }]);

    const inside = await target();
    await expect(
      grantAs(admin, { userId: inside.userId, roleId: role, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.teamA1 }] }),
    ).resolves.toBeDefined();
    await expect(
      grantAs(admin, { userId: (await target()).userId, roleId: role, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }] }),
    ).resolves.toBeDefined();

    for (const scopes of [
      [{ type: "ORG_UNIT" as const, orgUnitId: w.units.cityB }],
      [{ type: "ORG_UNIT" as const, orgUnitId: w.units.state }], // the parent is wider than the admin's unit
      [{ type: "TENANT" as const }],
      [{ type: "LEGAL_ENTITY" as const, legalEntityId: w.legalEntityId }],
    ]) {
      await expect(grantAs(admin, { userId: (await target()).userId, roleId: role, scopes })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("refuses roles containing permissions the granter does not hold", async () => {
    const admin = await cityAAdmin();
    // City Manager carries employees.*, dispatch.* ... which this admin lacks.
    await expect(
      grantAs(admin, { userId: (await target()).userId, roleId: w.roles.CITY_MANAGER, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // And the admin cannot clone their own power: permissions.assign needs permissions.assign over that scope,
    // which they have, so this one is allowed (they may delegate what they hold)...
    const delegable = await makeRole(w.tenantId, "Delegable", [{ permission: "jobs.view" }, { permission: "permissions.assign" }]);
    await expect(
      grantAs(admin, { userId: (await target()).userId, roleId: delegable, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }] }),
    ).resolves.toBeDefined();
    // ...but a role with a permission they do not hold is refused even when everything else is fine.
    const extra = await makeRole(w.tenantId, "Extra", [{ permission: "jobs.view" }, { permission: "jobs.edit" }]);
    await expect(
      grantAs(admin, { userId: (await target()).userId, roleId: extra, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses roles whose sensitive field categories the granter does not hold", async () => {
    const admin = await cityAAdmin(); // jobs.view with base fields only
    const withFinancial = await makeRole(w.tenantId, "Jobs financial", [
      { permission: "jobs.view", conditions: { includeFields: ["financial"] } },
    ]);
    const financialOnly = await makeRole(w.tenantId, "Jobs financial only", [
      { permission: "jobs.view", conditions: { fields: "financial" } },
    ]);
    const operationalOnly = await makeRole(w.tenantId, "Jobs operational", [
      { permission: "jobs.view", conditions: { fields: "operational" } },
    ]);
    const scopes = [{ type: "ORG_UNIT" as const, orgUnitId: w.units.cityA }];
    await expect(grantAs(admin, { userId: (await target()).userId, roleId: withFinancial, scopes })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(grantAs(admin, { userId: (await target()).userId, roleId: financialOnly, scopes })).rejects.toBeInstanceOf(ForbiddenError);
    // Non-sensitive limited sets are covered by the base fields the admin holds.
    await expect(grantAs(admin, { userId: (await target()).userId, roleId: operationalOnly, scopes })).resolves.toBeDefined();
  });

  it("enforces non_sensitive_roles: a COO grants ordinary roles but never sensitive or MFA-protected ones", async () => {
    const coo = await createPerson(w.tenantId, "coo", { withEmployee: false });
    await grantTemplate(w.tenantId, coo, w.roles.COO, [{ type: "TENANT" }]);

    const dispatcher = await target();
    await expect(
      grantAs(coo, { userId: dispatcher.userId, roleId: w.roles.DISPATCHER, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }] }),
    ).resolves.toBeDefined();

    for (const key of ["FINANCE_DIRECTOR", "OWNER_CEO", "HR_MANAGER"]) {
      await expect(
        grantAs(coo, { userId: (await target()).userId, roleId: w.roles[key], scopes: [{ type: "TENANT" }] }),
        key,
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    // A role flagged requiresMfa is sensitive however harmless its permissions look.
    const mfaRole = await makeRole(w.tenantId, "Plain but MFA", [{ permission: "jobs.view" }]);
    await withTenant(w.tenantId, (tx) => tx.role.update({ where: { id: mfaRole }, data: { requiresMfa: true } }));
    await expect(
      grantAs(coo, { userId: (await target()).userId, roleId: mfaRole, scopes: [{ type: "TENANT" }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a granter whose own access has lapsed", async () => {
    const admin = await cityAAdmin();
    await withTenant(w.tenantId, (tx) =>
      tx.roleAssignment.updateMany({
        where: { userId: admin.userId },
        data: { effectiveFrom: new Date(Date.now() - 7_200_000), effectiveTo: new Date(Date.now() - 3_600_000) },
      }),
    );
    const role = await makeRole(w.tenantId, "Jobs viewer", [{ permission: "jobs.view" }]);
    await expect(
      grantAs(admin, { userId: (await target()).userId, roleId: role, scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
