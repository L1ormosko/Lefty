import type { ScopeType } from "@prisma/client";
import type { Actor } from "@/server/core";
import { prisma, withTenant } from "@/server/db";
import { bootstrapRoleAssignment, provisionRoleTemplates } from "@/server/authz";
import { createTenant } from "../helpers";

export interface Person {
  userId: string;
  employeeId: string | null;
  actor: Actor;
}

/**
 * A tenant with a small org tree, one person per role template and every template provisioned.
 *
 *   Company LE
 *   State S ── City A ── Team A1
 *           └─ City B
 *   Region X (outside S, a separate root)
 */
export interface World {
  tenantId: string;
  legalEntityId: string;
  units: { state: string; cityA: string; teamA1: string; cityB: string; outside: string };
  roles: Record<string, string>;
  ceo: Person;
  stateManager: Person;
  cityManagerA: Person;
  cityManagerB: Person;
  finance: Person;
  dispatcher: Person;
  hr: Person;
  techA1: Person;
  techA1Other: Person;
  techB: Person;
}

let counter = 0;

export function toActor(tenantId: string, userId: string, employeeId: string | null): Actor {
  return { tenantId, userId, employeeId, sessionId: "test-session", locale: null };
}

/** Creates an ACTIVE user, optionally with an employee placed in `orgUnitId`. */
export async function createPerson(
  tenantId: string,
  label: string,
  options: { orgUnitId?: string; legalEntityId?: string; withEmployee?: boolean } = {},
): Promise<Person> {
  counter += 1;
  const withEmployee = options.withEmployee ?? options.orgUnitId !== undefined;
  return withTenant(tenantId, async (tx) => {
    const user = await tx.user.create({
      data: { tenantId, email: `${label}-${counter}@authz.test`, status: "ACTIVE" },
    });
    let employeeId: string | null = null;
    if (withEmployee) {
      const employee = await tx.employee.create({
        data: {
          tenantId,
          userId: user.id,
          legalEntityId: options.legalEntityId,
          firstName: label,
          lastName: "Test",
          // Placement started yesterday so "now" is inside it and it can be ended later.
          assignments: options.orgUnitId
            ? { create: { orgUnitId: options.orgUnitId, effectiveFrom: new Date(Date.now() - 86_400_000) } }
            : undefined,
        },
      });
      employeeId = employee.id;
    }
    return { userId: user.id, employeeId, actor: toActor(tenantId, user.id, employeeId) };
  });
}

export async function grantTemplate(
  tenantId: string,
  person: Person,
  roleId: string,
  scopes: Array<{ type: ScopeType; orgUnitId?: string; legalEntityId?: string; includeDescendants?: boolean }>,
  window: { effectiveFrom?: Date; effectiveTo?: Date } = {},
): Promise<string> {
  const { roleAssignmentId } = await withTenant(tenantId, (tx) =>
    bootstrapRoleAssignment(tx, { tenantId, userId: person.userId, roleId, scopes, ...window }),
  );
  return roleAssignmentId;
}

/** Creates a custom (non-template) role holding exactly the given permissions. */
export async function makeRole(
  tenantId: string,
  name: string,
  grants: Array<{ permission: string; conditions?: Record<string, unknown> }>,
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const role = await tx.role.create({ data: { tenantId, name: `${name} ${Date.now()}-${counter++}` } });
    for (const grant of grants) {
      const permission = await tx.permission.findUniqueOrThrow({ where: { key: grant.permission } });
      await tx.rolePermission.create({
        data: { tenantId, roleId: role.id, permissionId: permission.id, conditions: grant.conditions as never },
      });
    }
    return role.id;
  });
}

export async function buildWorld(label = "authz"): Promise<World> {
  const tenant = await createTenant(label);
  const tenantId = tenant.id;

  const base = await withTenant(tenantId, async (tx) => {
    const legalEntity = await tx.legalEntity.create({ data: { tenantId, name: "Company LE" } });
    const mk = (type: "STATE" | "CITY" | "TEAM" | "REGION", name: string, parentId?: string) =>
      tx.orgUnit.create({ data: { tenantId, type, name, parentId, legalEntityId: legalEntity.id } });
    const state = await mk("STATE", "State S");
    const cityA = await mk("CITY", "City A", state.id);
    const teamA1 = await mk("TEAM", "Team A1", cityA.id);
    const cityB = await mk("CITY", "City B", state.id);
    const outside = await mk("REGION", "Region X");
    const roles = await provisionRoleTemplates(tx, tenantId);
    return {
      legalEntityId: legalEntity.id,
      roles,
      units: { state: state.id, cityA: cityA.id, teamA1: teamA1.id, cityB: cityB.id, outside: outside.id },
    };
  });
  const { units, roles, legalEntityId } = base;

  const ceo = await createPerson(tenantId, "ceo", { withEmployee: false });
  const finance = await createPerson(tenantId, "finance", { withEmployee: false });
  const hr = await createPerson(tenantId, "hr", { withEmployee: false });
  const stateManager = await createPerson(tenantId, "state-mgr", { orgUnitId: units.state, legalEntityId });
  const cityManagerA = await createPerson(tenantId, "city-mgr-a", { orgUnitId: units.cityA, legalEntityId });
  const cityManagerB = await createPerson(tenantId, "city-mgr-b", { orgUnitId: units.cityB, legalEntityId });
  const dispatcher = await createPerson(tenantId, "dispatcher", { orgUnitId: units.state, legalEntityId });
  const techA1 = await createPerson(tenantId, "tech-a1", { orgUnitId: units.teamA1, legalEntityId });
  const techA1Other = await createPerson(tenantId, "tech-a1-other", { orgUnitId: units.teamA1, legalEntityId });
  const techB = await createPerson(tenantId, "tech-b", { orgUnitId: units.cityB, legalEntityId });

  await grantTemplate(tenantId, ceo, roles.OWNER_CEO, [{ type: "TENANT" }]);
  await grantTemplate(tenantId, finance, roles.FINANCE_DIRECTOR, [{ type: "TENANT" }]);
  await grantTemplate(tenantId, hr, roles.HR_MANAGER, [{ type: "TENANT" }]);
  await grantTemplate(tenantId, stateManager, roles.STATE_MANAGER, [{ type: "ORG_UNIT", orgUnitId: units.state }]);
  await grantTemplate(tenantId, cityManagerA, roles.CITY_MANAGER, [{ type: "ORG_UNIT", orgUnitId: units.cityA }]);
  await grantTemplate(tenantId, cityManagerB, roles.CITY_MANAGER, [{ type: "ORG_UNIT", orgUnitId: units.cityB }]);
  await grantTemplate(tenantId, dispatcher, roles.DISPATCHER, [{ type: "ORG_UNIT", orgUnitId: units.state }]);
  for (const tech of [techA1, techA1Other, techB]) {
    await grantTemplate(tenantId, tech, roles.TECHNICIAN, [{ type: "OWN" }, { type: "ASSIGNED" }]);
  }

  return {
    tenantId,
    legalEntityId,
    units,
    roles,
    ceo,
    stateManager,
    cityManagerA,
    cityManagerB,
    finance,
    dispatcher,
    hr,
    techA1,
    techA1Other,
    techB,
  };
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
