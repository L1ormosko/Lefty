import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/lib/i18n";
import { withTenant } from "@/server/db";
import { listInvitations } from "@/server/users";
import { buildWorld } from "../authz/fixtures";
import { resetFakeRequest } from "./next-fakes";
import { form, htmlOf, signInPerson } from "./admin-test-helpers";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import { createEmployeeAction, inviteEmployeeAction } from "@/app/(app)/admin/employees/actions";
import { deactivateUserAction } from "@/app/(app)/admin/users/actions";
import UsersPage from "@/app/(app)/admin/users/page";
import { AccessDenied } from "@/app/(app)/admin/_components/AdminPage";

beforeEach(resetFakeRequest);
const en = (key: string) => CATALOGS["en-US"].messages[key];
const noParams = { searchParams: Promise.resolve({}) };

describe("users page and actions", () => {
  it("lists users inside the caller's scope only", async () => {
    const world = await buildWorld("admin-users-scope");
    await signInPerson(world.cityManagerA, world.tenantId);
    // City Managers hold users.view? They do not: the template grants employees, not users.
    expect(((await UsersPage(noParams)) as { type: unknown }).type).toBe(AccessDenied);

    await signInPerson(world.ceo, world.tenantId);
    const html = await htmlOf(UsersPage(noParams));
    expect(html).toContain("tech-a1");
    expect(html).toContain("tech-b");
  });

  it("deactivates a login with a reason, refuses self-deactivation and unauthorised callers", async () => {
    const world = await buildWorld("admin-users-deactivate");
    await signInPerson(world.techA1, world.tenantId);
    expect((await deactivateUserAction({}, form({ userId: world.techB.userId, reason: "x" }))).error).toBe(en("ERROR.FORBIDDEN"));

    await signInPerson(world.ceo, world.tenantId);
    expect((await deactivateUserAction({}, form({ userId: world.ceo.userId, reason: "me" }))).error).toBe(en("ERROR.FORBIDDEN"));
    expect((await deactivateUserAction({}, form({ userId: world.techB.userId }))).error).toBe(en("ADMIN.ERROR_FIELD_REASON"));
    expect((await deactivateUserAction({}, form({ userId: world.techB.userId, reason: "Left the company" }))).success).toBe(en("ADMIN.USERS_DEACTIVATED"));
    const user = await withTenant(world.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: world.techB.userId } }));
    expect(user.status).toBe("DEACTIVATED");
  });
});

describe("failed web access is audited", () => {
  const deniedFor = (tenantId: string, userId: string) =>
    withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { tenantId, actorUserId: userId, action: "authz.denied", outcome: "DENIED" } }));

  it("records a denied page load and a refused server action as authz.denied (source WEB)", async () => {
    const world = await buildWorld("admin-users-denials");
    await signInPerson(world.cityManagerA, world.tenantId);
    await UsersPage(noParams); // no users.view -> access-denied panel
    expect(await deniedFor(world.tenantId, world.cityManagerA.userId)).toHaveLength(1);

    await signInPerson(world.techA1, world.tenantId);
    await deactivateUserAction({}, form({ userId: world.techB.userId, reason: "x" }));
    const events = await deniedFor(world.tenantId, world.techA1.userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.sourceApp).toBe("WEB");
  });
});

describe("listInvitations", () => {
  it("shows a pending invitation with its employee and role, never the token, and respects scope", async () => {
    const world = await buildWorld("admin-invitations");
    await signInPerson(world.ceo, world.tenantId);
    await createEmployeeAction({}, form({ firstName: "Pending", lastName: "Invitee", email: "pending@example.test", orgUnitId: world.units.cityA }));
    const employee = await withTenant(world.tenantId, (tx) => tx.employee.findFirstOrThrow({ where: { tenantId: world.tenantId, firstName: "Pending" } }));
    const result = await inviteEmployeeAction({}, form({ employeeId: employee.id, roleId: world.roles.TECHNICIAN, scopeType: "OWN" }));
    expect(result.success).toBeTruthy();

    const page = await listInvitations(world.ceo.actor, { limit: 10 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ email: "pending@example.test", employeeName: "Pending Invitee", state: "PENDING" });
    expect(page.data[0].roleName).toBeTruthy();
    expect(JSON.stringify(page.data)).not.toMatch(/token/i);

    // The HR Manager is tenant-wide for employees but holds no users.view: refused.
    await expect(listInvitations(world.hr.actor, { limit: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listInvitations(world.ceo.actor, { limit: 10, state: "ACCEPTED" })).data).toEqual([]);
  });
});
