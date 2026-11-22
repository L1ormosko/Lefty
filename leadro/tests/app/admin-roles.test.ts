import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/lib/i18n";
import { withTenant } from "@/server/db";
import { buildWorld } from "../authz/fixtures";
import { resetFakeRequest } from "./next-fakes";
import { form, htmlOf, signInPerson } from "./admin-test-helpers";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import { cloneRoleAction, createRoleAction, grantRoleAction, revokeAssignmentAction, saveRoleAction } from "@/app/(app)/admin/roles/actions";
import RolesPage from "@/app/(app)/admin/roles/page";
import { AccessDenied } from "@/app/(app)/admin/_components/AdminPage";

beforeEach(resetFakeRequest);
const en = (key: string) => CATALOGS["en-US"].messages[key];
const noParams = { searchParams: Promise.resolve({}) };

function formWith(values: Record<string, string>, permissions: string[]): FormData {
  const data = form(values);
  for (const permission of permissions) data.append("permission", permission);
  return data;
}

describe("roles actions", () => {
  it("creates, clones and edits a role from the permission grid, preserving nothing it should not", async () => {
    const world = await buildWorld("admin-roles-crud");
    await signInPerson(world.ceo, world.tenantId);
    expect((await createRoleAction({}, formWith({ name: "Auditor" }, ["employees.view", "audit.view"]))).success).toBe(en("ADMIN.ROLES_CREATED"));
    const role = await withTenant(world.tenantId, (tx) => tx.role.findFirstOrThrow({ where: { tenantId: world.tenantId, name: "Auditor" } }));
    expect((await cloneRoleAction({}, form({ roleId: role.id, name: "Auditor 2" }))).success).toBe(en("ADMIN.ROLES_CLONED"));
    expect((await saveRoleAction({}, formWith({ roleId: role.id, name: "Auditor", reason: "trim" }, ["employees.view"]))).success).toBe(en("ADMIN.SAVED"));
    const count = await withTenant(world.tenantId, (tx) => tx.rolePermission.count({ where: { roleId: role.id } }));
    expect(count).toBe(1);
  });

  it("refuses role administration to a City Manager on the server", async () => {
    const world = await buildWorld("admin-roles-deny");
    await signInPerson(world.cityManagerA, world.tenantId);
    expect((await createRoleAction({}, formWith({ name: "Sneaky" }, ["employees.view"]))).error).toBeTruthy();
    expect(((await RolesPage(noParams)) as { type: unknown }).type).toBe(AccessDenied);
  });

  it("will not let anyone put a permission into a role they do not hold", async () => {
    const world = await buildWorld("admin-roles-escalation");
    await signInPerson(world.ceo, world.tenantId);
    const result = await createRoleAction({}, formWith({ name: "Bogus" }, ["not.a_permission"]));
    expect(result.error).toBeTruthy();
  });

  it("grants a role with a scope and expiry, then revokes it with a reason", async () => {
    const world = await buildWorld("admin-roles-grant");
    await signInPerson(world.ceo, world.tenantId);
    const granted = await grantRoleAction({}, form({ roleId: world.roles.TEAM_LEADER, userId: world.techB.userId, scopeType: "ORG_UNIT", scopeOrgUnitId: world.units.cityB, effectiveTo: "2099-01-01", reason: "Cover" }));
    expect(granted.success).toBe(en("ADMIN.ROLES_GRANTED"));
    const assignment = await withTenant(world.tenantId, (tx) => tx.roleAssignment.findFirstOrThrow({ where: { userId: world.techB.userId, roleId: world.roles.TEAM_LEADER } }));
    expect(assignment.effectiveTo).not.toBeNull();

    const noScope = await grantRoleAction({}, form({ roleId: world.roles.TEAM_LEADER, userId: world.techB.userId, reason: "x" }));
    expect(noScope.error).toBeTruthy();
    expect((await revokeAssignmentAction({}, form({ assignmentId: assignment.id, roleId: world.roles.TEAM_LEADER, reason: "Done" }))).success).toBe(en("ADMIN.ROLES_REVOKED"));
    expect((await withTenant(world.tenantId, (tx) => tx.roleAssignment.findUniqueOrThrow({ where: { id: assignment.id } }))).revokedAt).not.toBeNull();
  });

  it("refuses a grant by someone without permissions.assign", async () => {
    const world = await buildWorld("admin-roles-grant-deny");
    await signInPerson(world.hr, world.tenantId);
    const result = await grantRoleAction({}, form({ roleId: world.roles.TEAM_LEADER, userId: world.techB.userId, scopeType: "OWN", reason: "x" }));
    expect(result.error).toBeTruthy();
  });
});

describe("why can this user access this record?", () => {
  it("explains an allowed and a denied decision for the CEO's lookup", async () => {
    const world = await buildWorld("admin-roles-why");
    await signInPerson(world.ceo, world.tenantId);
    const allowed = await htmlOf(RolesPage({ searchParams: Promise.resolve({ user: world.cityManagerA.userId, permission: "employees.view", employee: world.techA1.employeeId ?? "" }) }));
    expect(allowed).toContain(en("ADMIN.WHY_ALLOWED"));
    const denied = await htmlOf(RolesPage({ searchParams: Promise.resolve({ user: world.cityManagerA.userId, permission: "employees.view", employee: world.techB.employeeId ?? "" }) }));
    expect(denied).toContain(en("ADMIN.WHY_DENIED"));
    expect(denied).toContain("the record is outside the assignment"); // apostrophe is HTML-escaped in markup
  });
});
