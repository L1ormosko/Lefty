import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acceptInvitation,
  createInvitationUnchecked,
  resetAuthNotifier,
  resetRateLimits,
  setAuthNotifier,
  userRequiresMfa,
  type InvitationMessage,
} from "@/server/auth";
import { holdsMfaRequiringRole, revokeRoleAssignment } from "@/server/authz";
import { ForbiddenError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import { POST as inviteRoute } from "@/app/api/v1/employees/[id]/invitations/route";
import { inviteEmployee } from "@/server/employees";
import { testClient, TEST_PASSWORD } from "../auth/auth-helpers";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type Person, type World } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";

let w: World;
const sent: InvitationMessage[] = [];

beforeAll(async () => {
  w = await buildWorld("integration-invite");
});
afterAll(disconnect);
beforeEach(() => {
  sent.length = 0;
  resetRateLimits();
  setAuthNotifier({ async sendPasswordReset() {}, async sendInvitation(message) { sent.push(message); } });
});
afterAll(() => resetAuthNotifier());

let counter = 0;
const email = () => `invitee-${Date.now().toString(36)}-${++counter}@integration.test`;

/** A delegated admin for City A: may invite users and assign roles inside it, and holds jobs.view there. */
async function cityAAdmin(): Promise<{ admin: Person; assignmentId: string }> {
  const roleId = await makeRole(w.tenantId, "City A admin", [
    { permission: "permissions.assign" },
    { permission: "users.create" },
    { permission: "employees.view" },
    { permission: "jobs.view" },
  ]);
  const admin = await createPerson(w.tenantId, "inviter", { orgUnitId: w.units.cityA });
  const assignmentId = await grantTemplate(w.tenantId, admin, roleId, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
  return { admin, assignmentId };
}

const jobsViewer = () => makeRole(w.tenantId, "Jobs viewer", [{ permission: "jobs.view" }]);

describe("auth MFA policy uses authz's definition of an active assignment", () => {
  it("counts only active assignments of active roles", async () => {
    const person = await createPerson(w.tenantId, "mfa-check", { withEmployee: false });
    const mfaRole = await makeRole(w.tenantId, "mfa role", [{ permission: "jobs.view" }]);
    await withTenant(w.tenantId, (tx) => tx.role.update({ where: { id: mfaRole }, data: { requiresMfa: true } }));
    const check = () =>
      withTenant(w.tenantId, async (tx) => ({
        viaAuth: await userRequiresMfa(tx, w.tenantId, person.userId),
        viaAuthz: await holdsMfaRequiringRole(tx, w.tenantId, person.userId),
      }));

    expect(await check()).toEqual({ viaAuth: false, viaAuthz: false });
    const assignmentId = await grantTemplate(w.tenantId, person, mfaRole, [{ type: "TENANT" }]);
    expect(await check()).toEqual({ viaAuth: true, viaAuthz: true });

    await withTenant(w.tenantId, (tx) => tx.roleAssignment.update({ where: { id: assignmentId }, data: { revokedAt: new Date() } }));
    expect(await check()).toEqual({ viaAuth: false, viaAuthz: false });
  });
});

describe("invitation creation runs the anti-escalation dry run", () => {
  it("lets an administrator invite with a role they could grant themselves, and delivers the token to the notifier only", async () => {
    const { admin } = await cityAAdmin();
    const target = await createPerson(w.tenantId, "target", { orgUnitId: w.units.cityA, withEmployee: true });
    const roleId = await jobsViewer();
    const address = email();
    await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: target.employeeId! }, data: { email: address, userId: null } }));
    // the fixture person already has a user; detach so the employee can be invited
    await withTenant(w.tenantId, (tx) => tx.user.delete({ where: { id: target.userId } }).catch(() => undefined));

    const result = await inviteEmployee(
      admin.actor,
      target.employeeId!,
      { roleId, scope: { type: "ORG_UNIT", orgUnitId: w.units.cityA, includeDescendants: true } },
      testClient(),
    );
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "invitationId"]); // no token in the return value
    expect(sent).toHaveLength(1);
    expect(sent[0].email).toBe(address);
    expect(sent[0].token).toMatch(/^[^.]+\./);
  });

  it("refuses a role the inviter does not hold (dispatch permissions), a scope outside their reach, and a sensitive role", async () => {
    const { admin } = await cityAAdmin();
    const invite = (roleId: string, orgUnitId: string) =>
      createInvitationUnchecked(
        w.tenantId,
        { email: email(), invitedById: admin.userId, roleId, scope: { type: "ORG_UNIT", orgUnitId } },
        testClient(),
      );

    await expect(invite(w.roles.DISPATCHER, w.units.cityA)).rejects.toBeInstanceOf(ForbiddenError); // permissions not held
    await expect(invite(await jobsViewer(), w.units.cityB)).rejects.toBeInstanceOf(ForbiddenError); // outside scope
    await expect(invite(w.roles.OWNER_CEO, w.units.cityA)).rejects.toBeInstanceOf(ForbiddenError); // sensitive + not held
    expect(sent).toHaveLength(0); // nothing was mailed for any refused invitation
  });

  it("a tenant-level invitee (no employee) needs a tenant-wide permissions.assign", async () => {
    const { admin } = await cityAAdmin();
    await expect(
      createInvitationUnchecked(w.tenantId, { email: email(), invitedById: admin.userId, roleId: await jobsViewer(), scope: { type: "ORG_UNIT", orgUnitId: w.units.cityA } }, testClient()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createInvitationUnchecked(w.tenantId, { email: email(), invitedById: w.ceo.userId, roleId: await jobsViewer(), scope: { type: "ORG_UNIT", orgUnitId: w.units.cityA } }, testClient()),
    ).resolves.toBeTruthy();
  });
});

describe("invitation acceptance creates the assignment through authz and re-validates the inviter", () => {
  async function invited(admin: Person, orgUnitId = w.units.cityA) {
    const employee = await createPerson(w.tenantId, "invitee", { orgUnitId, withEmployee: true });
    // drop the fixture's pre-made user: the real flow creates the account when the invitation is accepted
    await withTenant(w.tenantId, async (tx) => {
      await tx.employee.update({ where: { id: employee.employeeId! }, data: { userId: null } });
      await tx.user.delete({ where: { id: employee.userId } });
    });
    const roleId = await jobsViewer();
    const address = email();
    const invitation = await createInvitationUnchecked(
      w.tenantId,
      { email: address, invitedById: admin.userId, employeeId: employee.employeeId!, roleId, scope: { type: "ORG_UNIT", orgUnitId: w.units.cityA } },
      testClient(),
    );
    return { employee, roleId, address, invitation };
  }

  it("grants the role with the explicit scope, granted by the inviter, and links the employee", async () => {
    const { admin } = await cityAAdmin();
    const { employee, roleId, address, invitation } = await invited(admin);
    const { userId } = await acceptInvitation({ token: invitation.token, password: TEST_PASSWORD }, testClient());

    await withTenant(w.tenantId, async (tx) => {
      const assignments = await tx.roleAssignment.findMany({ where: { userId }, include: { scopes: true } });
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({ roleId, grantedById: admin.userId });
      expect(assignments[0].scopes).toMatchObject([{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
      expect((await tx.employee.findUniqueOrThrow({ where: { id: employee.employeeId! } })).userId).toBe(userId);
      expect((await tx.user.findUniqueOrThrow({ where: { id: userId } })).email).toBe(address);
      const audit = await tx.auditEvent.findMany({ where: { action: "role_assignment.grant", targetId: assignments[0].id } });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorUserId).toBe(admin.userId);
    });
  });

  it("is refused (generic error, token NOT consumed) when the inviter lost their authority meanwhile", async () => {
    const { admin, assignmentId } = await cityAAdmin();
    const { invitation, address } = await invited(admin);
    // The CEO strips the inviter's admin role after the invitation was issued.
    await withTenant(w.tenantId, (tx) => revokeRoleAssignment(tx, w.ceo.actor, { roleAssignmentId: assignmentId, reason: "left" }));

    const error = await acceptInvitation({ token: invitation.token, password: TEST_PASSWORD }, testClient()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toMatch(/invalid or has expired/);

    const row = await withTenant(w.tenantId, (tx) => tx.invitation.findUniqueOrThrow({ where: { id: invitation.invitationId } }));
    expect(row.acceptedAt).toBeNull(); // rolled back
    expect(await withTenant(w.tenantId, (tx) => tx.user.count({ where: { email: address } }))).toBe(0);
  });

  it("is refused when the scope's org unit was archived after the invitation was issued", async () => {
    const unit = await withTenant(w.tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId: w.tenantId, type: "TEAM", name: `Doomed ${Date.now()}`, parentId: w.units.cityA } }),
    );
    // Issued by the tenant-wide Owner: even a tenant-wide granter must not hand out a dead scope at accept time.
    const issued = await createInvitationUnchecked(
      w.tenantId,
      { email: email(), invitedById: w.ceo.userId, roleId: await jobsViewer(), scope: { type: "ORG_UNIT", orgUnitId: unit.id } },
      testClient(),
    );
    await withTenant(w.tenantId, (tx) => tx.orgUnit.update({ where: { id: unit.id }, data: { active: false } }));
    await expect(acceptInvitation({ token: issued.token, password: TEST_PASSWORD }, testClient())).rejects.toBeInstanceOf(ValidationError);
  });

  it("a system invitation (no inviter) is still granted, with its scope", async () => {
    const roleId = await jobsViewer();
    const invitation = await createInvitationUnchecked(
      w.tenantId,
      { email: email(), invitedById: null, roleId, scope: { type: "TENANT" } },
      testClient(),
    );
    const { userId } = await acceptInvitation({ token: invitation.token, password: TEST_PASSWORD }, testClient());
    const scopes = await withTenant(w.tenantId, (tx) => tx.accessScope.findMany({ where: { roleAssignment: { userId } } }));
    expect(scopes.map((scope) => scope.type)).toEqual(["TENANT"]);
  });
});

describe("employee invitation API", () => {
  it("requires users.create over the employee and never returns the token", async () => {
    const employee = await createPerson(w.tenantId, "api-invitee", { orgUnitId: w.units.cityA, withEmployee: true });
    await withTenant(w.tenantId, async (tx) => {
      await tx.employee.update({ where: { id: employee.employeeId! }, data: { userId: null, email: email() } });
      await tx.user.delete({ where: { id: employee.userId } });
    });
    const technician = await sessionCookie(w.techA1, w.tenantId);
    const denied = await call(inviteRoute, "POST", "/x", { cookie: technician, params: { id: employee.employeeId! }, body: {} });
    expect(denied.status).toBe(403);

    const ceo = await sessionCookie(w.ceo, w.tenantId);
    const ok = await call(inviteRoute, "POST", "/x", { cookie: ceo, params: { id: employee.employeeId! }, body: {} });
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.json.data).sort()).toEqual(["expiresAt", "invitationId"]);
    expect(JSON.stringify(ok.json)).not.toContain(sent[0].token);
    expect(sent).toHaveLength(1);
  });

  it("rejects: no email, a role without scope, an employee that already has a login, an email owned by an active account", async () => {
    const ceo = await sessionCookie(w.ceo, w.tenantId);
    const noEmail = await createPerson(w.tenantId, "no-email", { orgUnitId: w.units.cityA, withEmployee: true });
    await withTenant(w.tenantId, async (tx) => {
      await tx.employee.update({ where: { id: noEmail.employeeId! }, data: { userId: null } });
      await tx.user.delete({ where: { id: noEmail.userId } });
    });
    expect((await call(inviteRoute, "POST", "/x", { cookie: ceo, params: { id: noEmail.employeeId! }, body: {} })).status).toBe(400);
    expect((await call(inviteRoute, "POST", "/x", { cookie: ceo, params: { id: noEmail.employeeId! }, body: { email: email(), roleId: "r" } })).status).toBe(400);
    expect((await call(inviteRoute, "POST", "/x", { cookie: ceo, params: { id: w.techA1.employeeId! }, body: {} })).status).toBe(409); // already has a login
    const taken = await withTenant(w.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: w.techB.userId } }));
    expect((await call(inviteRoute, "POST", "/x", { cookie: ceo, params: { id: noEmail.employeeId! }, body: { email: taken.email } })).status).toBe(409);
    expect(sent).toHaveLength(0);
  });
});

describe("invitation creation is one transaction with its authority check", () => {
  it("a failing in-transaction precheck creates nothing and sends nothing", async () => {
    const address = email();
    await expect(
      createInvitationUnchecked(w.tenantId, { email: address, invitedById: null }, testClient(), async () => {
        throw new ForbiddenError();
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await withTenant(w.tenantId, (tx) => tx.invitation.count({ where: { email: address } }))).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
