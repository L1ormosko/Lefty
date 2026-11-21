import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listAssignments, POST as grant } from "@/app/api/v1/roles/assignments/route";
import { POST as revoke } from "@/app/api/v1/roles/assignments/[id]/revoke/route";
import { GET as effectiveAccess } from "@/app/api/v1/roles/effective-access/route";
import { can } from "@/server/authz";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type Person, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let ceo: string;
let cityAdmin: Person;
let cityAdminCookie: string;
let jobsRole: string;

beforeAll(async () => {
  w = await buildWorld("role-assignments");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  // May assign roles inside City A, and holds jobs.view + permissions.view there.
  const adminRole = await makeRole(w.tenantId, "City A role admin", [
    { permission: "permissions.assign" },
    { permission: "permissions.view" },
    { permission: "jobs.view" },
  ]);
  cityAdmin = await createPerson(w.tenantId, "city-admin", { orgUnitId: w.units.cityA });
  await grantTemplate(w.tenantId, cityAdmin, adminRole, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
  cityAdminCookie = await sessionCookie(cityAdmin, w.tenantId);
  jobsRole = await makeRole(w.tenantId, "Jobs viewer", [{ permission: "jobs.view" }]);
});
afterAll(disconnect);

const DAY = 86_400_000;
const grantRole = (cookie: string, body: Record<string, unknown>) => call(grant, "POST", "/api/v1/roles/assignments", { cookie, body });
const body = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId,
  roleId: jobsRole,
  scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }],
  reason: "Needs to see jobs",
  ...extra,
});

describe("granting roles", () => {
  it("grants with scope and expiry, records granter and reason, and the permission applies", async () => {
    const person = await createPerson(w.tenantId, "grantee", { orgUnitId: w.units.cityA });
    const expiry = new Date(Date.now() + 7 * DAY).toISOString();
    const result = await grantRole(ceo, body(person.userId, { effectiveTo: expiry }));
    expect(result.status).toBe(201);
    expect((await can(person.actor, "jobs.view", { orgUnitId: w.units.cityA })).allowed).toBe(true);
    expect((await can(person.actor, "jobs.view", { orgUnitId: w.units.cityB })).allowed).toBe(false); // scope respected

    const row = await withTenant(w.tenantId, (tx) => tx.roleAssignment.findUniqueOrThrow({ where: { id: result.json.data.roleAssignmentId }, include: { scopes: true } }));
    expect(row).toMatchObject({ grantedById: w.ceo.userId, reason: "Needs to see jobs" });
    expect(row.effectiveTo?.toISOString()).toBe(expiry);
    expect(row.scopes).toHaveLength(1);
    const [event] = await auditEvents(w.tenantId, "role_assignment.grant", row.id);
    expect(event.actorUserId).toBe(w.ceo.userId);
  });

  it("refuses escalation: to yourself, scopes beyond your own, roles you do not hold, outsiders", async () => {
    const person = await createPerson(w.tenantId, "target-a", { orgUnitId: w.units.cityA });
    const outsider = await createPerson(w.tenantId, "target-b", { orgUnitId: w.units.cityB });

    expect((await grantRole(ceo, body(w.ceo.userId))).status).toBe(403); // never to yourself
    expect((await grantRole(cityAdminCookie, body(cityAdmin.userId))).status).toBe(403);
    expect((await grantRole(cityAdminCookie, body(person.userId, { scopes: [{ type: "TENANT" }] }))).status).toBe(403); // wider than their scope
    expect((await grantRole(cityAdminCookie, body(person.userId, { scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.state }] }))).status).toBe(403);
    expect((await grantRole(cityAdminCookie, body(person.userId, { roleId: w.roles.DISPATCHER }))).status).toBe(403); // permissions not held
    expect((await grantRole(cityAdminCookie, body(outsider.userId))).status).toBe(403); // target outside their administration
    expect((await grantRole(cityAdminCookie, body(person.userId))).status).toBe(201); // the legitimate one
  });

  it("validates input and rejects duplicates", async () => {
    const person = await createPerson(w.tenantId, "dup-target", { orgUnitId: w.units.cityA });
    expect((await grantRole(ceo, body(person.userId, { scopes: [] }))).status).toBe(400); // a role without scope grants nothing
    expect((await grantRole(ceo, body(person.userId, { scopes: [{ type: "ORG_UNIT" }] }))).status).toBe(400);
    expect((await grantRole(ceo, body(person.userId, { reason: undefined }))).status).toBe(400);
    expect((await grantRole(ceo, body(person.userId, { effectiveFrom: new Date(Date.now() + DAY).toISOString(), effectiveTo: new Date().toISOString() }))).status).toBe(400);
    expect((await grantRole(ceo, body(person.userId))).status).toBe(201);
    expect((await grantRole(ceo, body(person.userId))).status).toBe(409);
  });

  it("is invisible across tenants: foreign users, roles and scopes are 404", async () => {
    const other = await buildWorld("role-assignments-other");
    const person = await createPerson(w.tenantId, "iso-target", { orgUnitId: w.units.cityA });
    expect((await grantRole(ceo, body(other.techA1.userId))).status).toBe(404);
    expect((await grantRole(ceo, body(person.userId, { roleId: other.roles.DISPATCHER }))).status).toBe(404);
    expect((await grantRole(ceo, body(person.userId, { scopes: [{ type: "ORG_UNIT", orgUnitId: other.units.cityA }] }))).status).toBe(404);
    expect((await call(revoke, "POST", "/x", { cookie: ceo, params: { id: "unknown" }, body: { reason: "x" } })).status).toBe(404);
  });
});

describe("revoking and listing", () => {
  it("revokes now, keeps the row as history, audits the reason, and cannot revoke twice", async () => {
    const person = await createPerson(w.tenantId, "revokee", { orgUnitId: w.units.cityA });
    const assignmentId = (await grantRole(ceo, body(person.userId))).json.data.roleAssignmentId;
    expect((await can(person.actor, "jobs.view", { orgUnitId: w.units.cityA })).allowed).toBe(true);

    const result = await call(revoke, "POST", "/x", { cookie: ceo, params: { id: assignmentId }, body: { reason: "Role change" } });
    expect(result.status).toBe(204);
    expect((await can(person.actor, "jobs.view", { orgUnitId: w.units.cityA })).allowed).toBe(false); // effective on the next check
    const row = await withTenant(w.tenantId, (tx) => tx.roleAssignment.findUniqueOrThrow({ where: { id: assignmentId } }));
    expect(row).toMatchObject({ revokedById: w.ceo.userId });
    expect(row.revokedAt).not.toBeNull();
    expect((await auditEvents(w.tenantId, "role_assignment.revoke", assignmentId))[0].reason).toBe("Role change");
    expect((await call(revoke, "POST", "/x", { cookie: ceo, params: { id: assignmentId }, body: { reason: "again" } })).status).toBe(409);
    expect((await call(revoke, "POST", "/x", { cookie: ceo, params: { id: assignmentId }, body: {} })).status).toBe(400); // reason required
  });

  it("a delegated admin cannot revoke what they could not grant (tenant-wide scope, sensitive role)", async () => {
    const person = await createPerson(w.tenantId, "tenant-wide", { orgUnitId: w.units.cityA });
    const wide = (await grantRole(ceo, body(person.userId, { scopes: [{ type: "TENANT" }] }))).json.data.roleAssignmentId;
    expect((await call(revoke, "POST", "/x", { cookie: cityAdminCookie, params: { id: wide }, body: { reason: "x" } })).status).toBe(403);

    const narrow = (await grantRole(ceo, body(person.userId, { roleId: await makeRole(w.tenantId, "narrow", [{ permission: "jobs.view" }]) }))).json.data.roleAssignmentId;
    expect((await call(revoke, "POST", "/x", { cookie: cityAdminCookie, params: { id: narrow }, body: { reason: "ok" } })).status).toBe(204);

    const outsider = await createPerson(w.tenantId, "outsider", { orgUnitId: w.units.cityB });
    const theirs = (await grantRole(ceo, body(outsider.userId, { scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }] }))).json.data.roleAssignmentId;
    expect((await call(revoke, "POST", "/x", { cookie: cityAdminCookie, params: { id: theirs }, body: { reason: "x" } })).status).toBe(403);
    expect((await can(outsider.actor, "jobs.view", { orgUnitId: w.units.cityB })).allowed).toBe(true); // untouched
  });

  it("lists active assignments by default and the full history with state=all; paginates; filters", async () => {
    const person = await createPerson(w.tenantId, "history", { orgUnitId: w.units.cityA });
    const first = (await grantRole(ceo, body(person.userId))).json.data.roleAssignmentId;
    await call(revoke, "POST", "/x", { cookie: ceo, params: { id: first }, body: { reason: "x" } });
    const second = (await grantRole(ceo, body(person.userId))).json.data.roleAssignmentId;

    const active = await call(listAssignments, "GET", "/api/v1/roles/assignments", { cookie: ceo, query: { userId: person.userId } });
    expect(active.json.data.map((row: { id: string }) => row.id)).toEqual([second]);
    expect(active.json.data[0]).toMatchObject({ state: "ACTIVE", roleName: expect.any(String), userId: person.userId });

    const all = await call(listAssignments, "GET", "/x", { cookie: ceo, query: { userId: person.userId, state: "all" } });
    expect(all.json.data.map((row: { state: string }) => row.state).sort()).toEqual(["ACTIVE", "REVOKED"]);
    const pageOne = await call(listAssignments, "GET", "/x", { cookie: ceo, query: { userId: person.userId, state: "all", limit: "1" } });
    expect(pageOne.json.data).toHaveLength(1);
    expect(pageOne.json.page.nextCursor).toBeTruthy();
    const byRole = await call(listAssignments, "GET", "/x", { cookie: ceo, query: { roleId: w.roles.OWNER_CEO } });
    expect(byRole.json.data.every((row: { roleId: string }) => row.roleId === w.roles.OWNER_CEO)).toBe(true);
  });

  it("shows an expired temporary assignment as EXPIRED history, not as active access", async () => {
    const person = await createPerson(w.tenantId, "temporary", { orgUnitId: w.units.cityA });
    const id = (await grantRole(ceo, body(person.userId, { effectiveTo: new Date(Date.now() + DAY).toISOString() }))).json.data.roleAssignmentId;
    await withTenant(w.tenantId, (tx) =>
      tx.roleAssignment.update({ where: { id }, data: { effectiveFrom: new Date(Date.now() - 3 * DAY), effectiveTo: new Date(Date.now() - DAY) } }),
    );
    expect((await can(person.actor, "jobs.view", { orgUnitId: w.units.cityA })).allowed).toBe(false);
    const active = await call(listAssignments, "GET", "/x", { cookie: ceo, query: { userId: person.userId } });
    expect(active.json.data).toEqual([]);
    const all = await call(listAssignments, "GET", "/x", { cookie: ceo, query: { userId: person.userId, state: "all" } });
    expect(all.json.data[0].state).toBe("EXPIRED");
  });

  it("scope-filters the list: a City A administrator sees City A users' assignments only", async () => {
    const insider = await createPerson(w.tenantId, "list-in", { orgUnitId: w.units.cityA });
    const outsider = await createPerson(w.tenantId, "list-out", { orgUnitId: w.units.cityB });
    await grantRole(ceo, body(insider.userId));
    await grantRole(ceo, body(outsider.userId, { scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }] }));
    const result = await call(listAssignments, "GET", "/x", { cookie: cityAdminCookie, query: { limit: "200" } });
    const users = new Set(result.json.data.map((row: { userId: string }) => row.userId));
    expect(users.has(insider.userId)).toBe(true);
    expect(users.has(outsider.userId)).toBe(false);
    expect(users.has(w.ceo.userId)).toBe(false); // the Owner has no employee record: tenant-level
    expect((await call(listAssignments, "GET", "/x", { cookie: await sessionCookie(w.techA1, w.tenantId) })).status).toBe(403);
  });
});

describe("effective access", () => {
  it("shows what a user can do now, per assignment and scope, and why a single permission is granted", async () => {
    const result = await call(effectiveAccess, "GET", "/api/v1/roles/effective-access", {
      cookie: ceo,
      query: { userId: w.dispatcher.userId, permission: "dispatch.assign", orgUnitId: w.units.cityA },
    });
    expect(result.status).toBe(200);
    const data = result.json.data;
    expect(data.accountActive).toBe(true);
    expect(data.permissions).toContain("dispatch.assign");
    expect(data.assignments[0]).toMatchObject({ roleName: expect.stringMatching(/Dispatcher/), scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.state }] });
    expect(data.explanation.decision.allowed).toBe(true);
    expect(data.explanation.summary).toMatch(/Granted by role/);

    const denied = await call(effectiveAccess, "GET", "/x", { cookie: ceo, query: { userId: w.dispatcher.userId, permission: "dispatch.assign", orgUnitId: w.units.outside } });
    expect(denied.json.data.explanation.decision.allowed).toBe(false);
  });

  it("excludes revoked and expired assignments from the effective list", async () => {
    const person = await createPerson(w.tenantId, "eff-revoked", { orgUnitId: w.units.cityA });
    const id = (await grantRole(ceo, body(person.userId))).json.data.roleAssignmentId;
    await call(revoke, "POST", "/x", { cookie: ceo, params: { id }, body: { reason: "x" } });
    const result = await call(effectiveAccess, "GET", "/x", { cookie: ceo, query: { userId: person.userId } });
    expect(result.json.data.assignments).toEqual([]);
    expect(result.json.data.permissions).toEqual([]);
  });

  it("is itself scoped: unit admins cannot inspect outsiders or tenant-level users (404); other tenants too; no permission = 403", async () => {
    expect((await call(effectiveAccess, "GET", "/x", { cookie: cityAdminCookie, query: { userId: w.techB.userId } })).status).toBe(404);
    expect((await call(effectiveAccess, "GET", "/x", { cookie: cityAdminCookie, query: { userId: w.ceo.userId } })).status).toBe(404);
    expect((await call(effectiveAccess, "GET", "/x", { cookie: cityAdminCookie, query: { userId: w.techA1.userId } })).status).toBe(200);
    const other = await buildWorld("role-assignments-eff");
    expect((await call(effectiveAccess, "GET", "/x", { cookie: ceo, query: { userId: other.techA1.userId } })).status).toBe(404);
    expect((await call(effectiveAccess, "GET", "/x", { cookie: await sessionCookie(w.techA1, w.tenantId), query: { userId: w.techA1.userId } })).status).toBe(403);
    expect((await call(effectiveAccess, "GET", "/x", { cookie: ceo, query: {} })).status).toBe(400);
  });
});

