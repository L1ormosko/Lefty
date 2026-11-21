import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listUsers } from "@/app/api/v1/users/route";
import { GET as getUser, PATCH as patchUser } from "@/app/api/v1/users/[id]/route";
import { POST as deactivate } from "@/app/api/v1/users/[id]/deactivate/route";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type Person, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let ceo: string;
let cityAAdmin: Person;
let adminCookie: string;

beforeAll(async () => {
  w = await buildWorld("users");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  // Only the Owner template holds users.*; delegate a City A slice of it.
  const roleId = await makeRole(w.tenantId, "City A user admin", [
    { permission: "users.view" },
    { permission: "users.edit" },
    { permission: "users.archive" },
  ]);
  cityAAdmin = await createPerson(w.tenantId, "user-admin", { orgUnitId: w.units.cityA });
  await grantTemplate(w.tenantId, cityAAdmin, roleId, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
  adminCookie = await sessionCookie(cityAAdmin, w.tenantId);
});
afterAll(disconnect);

const idsOf = (result: { json: { data: Array<{ id: string }> } }) => result.json.data.map((user) => user.id);

describe("listing users", () => {
  it("shows a tenant-wide holder everyone, including users with no employee record", async () => {
    const result = await call(listUsers, "GET", "/api/v1/users", { cookie: ceo, query: { limit: "200" } });
    expect(result.status).toBe(200);
    expect(idsOf(result)).toEqual(expect.arrayContaining([w.ceo.userId, w.techA1.userId, w.techB.userId, w.cityManagerB.userId]));
  });

  it("scopes a unit-level admin to users whose employee is placed in their subtree", async () => {
    const result = await call(listUsers, "GET", "/x", { cookie: adminCookie, query: { limit: "200" } });
    const ids = idsOf(result);
    expect(ids).toContain(w.techA1.userId);
    expect(ids).toContain(w.cityManagerA.userId);
    expect(ids).toContain(cityAAdmin.userId);
    expect(ids).not.toContain(w.techB.userId);
    expect(ids).not.toContain(w.cityManagerB.userId);
    expect(ids).not.toContain(w.ceo.userId); // no employee record: tenant-level, invisible without a tenant-wide grant
  });

  it("never returns credentials or lockout state", async () => {
    await withTenant(w.tenantId, (tx) => tx.user.update({ where: { id: w.techA1.userId }, data: { passwordHash: "$2a$12$secrethashsecrethashsecrethashsecrethashsecrethashsecr", mfaSecretEncrypted: "enc:secret", failedLoginCount: 3 } }));
    const list = await call(listUsers, "GET", "/x", { cookie: ceo, query: { limit: "200" } });
    const one = await call(getUser, "GET", "/x", { cookie: ceo, params: { id: w.techA1.userId } });
    for (const response of [list, one]) {
      const text = JSON.stringify(response.json);
      for (const forbidden of ["passwordHash", "secrethash", "mfaSecret", "enc:secret", "failedLoginCount", "lockedUntil", "mfaLastUsedStep"]) {
        expect(text).not.toContain(forbidden);
      }
    }
    expect(one.json.data).toMatchObject({ id: w.techA1.userId, employeeId: w.techA1.employeeId, firstName: "tech-a1" });
  });

  it("filters, searches and paginates", async () => {
    const active = await call(listUsers, "GET", "/x", { cookie: ceo, query: { status: "ACTIVE", search: "tech-a1", limit: "1" } });
    expect(active.json.data.length).toBe(1);
    expect(active.json.page.nextCursor).toBeTruthy(); // tech-a1 and tech-a1-other both match
    const second = await call(listUsers, "GET", "/x", { cookie: ceo, query: { status: "ACTIVE", search: "tech-a1", limit: "1", cursor: active.json.page.nextCursor } });
    expect(second.json.data[0].id).not.toBe(active.json.data[0].id);
  });

  it("denies people without users.view and unauthenticated callers", async () => {
    expect((await call(listUsers, "GET", "/x", { cookie: await sessionCookie(w.techA1, w.tenantId) })).status).toBe(403);
    expect((await call(listUsers, "GET", "/x")).status).toBe(401);
  });
});

describe("single user access and isolation", () => {
  it("hides users outside the caller's scope and other tenants' users (404)", async () => {
    expect((await call(getUser, "GET", "/x", { cookie: adminCookie, params: { id: w.techB.userId } })).status).toBe(404);
    expect((await call(getUser, "GET", "/x", { cookie: adminCookie, params: { id: w.ceo.userId } })).status).toBe(404);
    const other = await buildWorld("users-other");
    expect((await call(getUser, "GET", "/x", { cookie: ceo, params: { id: other.techA1.userId } })).status).toBe(404);
    expect((await call(patchUser, "PATCH", "/x", { cookie: ceo, params: { id: other.techA1.userId }, body: { locale: "es-US" } })).status).toBe(404);
    expect((await call(deactivate, "POST", "/x", { cookie: ceo, params: { id: other.techA1.userId }, body: { reason: "x" } })).status).toBe(404);
    const untouched = await withTenant(other.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: other.techA1.userId } }));
    expect(untouched.status).toBe("ACTIVE");
  });

  it("updates preferences with an audit trail and rejects bad values", async () => {
    const result = await call(patchUser, "PATCH", "/x", { cookie: adminCookie, params: { id: w.techA1Other.userId }, body: { locale: "he-IL", timeZone: "Asia/Jerusalem" } });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ locale: "he-IL", timeZone: "Asia/Jerusalem" });
    const [event] = await auditEvents(w.tenantId, "user.update", w.techA1Other.userId);
    expect(event.newValue).toEqual({ locale: "he-IL", timeZone: "Asia/Jerusalem" });
    expect(event.actorUserId).toBe(cityAAdmin.userId);

    expect((await call(patchUser, "PATCH", "/x", { cookie: adminCookie, params: { id: w.techA1Other.userId }, body: { locale: "fr-FR" } })).status).toBe(400);
    expect((await call(patchUser, "PATCH", "/x", { cookie: adminCookie, params: { id: w.techA1Other.userId }, body: { email: "x@y.z" } })).status).toBe(400);
  });
});

describe("deactivating a user", () => {
  it("disables the login, revokes every session at once and audits the reason", async () => {
    const victim = await createPerson(w.tenantId, "victim", { orgUnitId: w.units.cityA });
    const victimCookie = await sessionCookie(victim, w.tenantId);
    expect((await call(getUser, "GET", "/x", { cookie: victimCookie, params: { id: victim.userId } })).status).toBe(403); // authenticated, no users.view

    const result = await call(deactivate, "POST", "/x", { cookie: adminCookie, params: { id: victim.userId }, body: { reason: "Left the company" } });
    expect(result.status).toBe(200);
    expect(result.json.data.revokedSessions).toBe(1);
    expect((await call(getUser, "GET", "/x", { cookie: victimCookie, params: { id: victim.userId } })).status).toBe(401); // session is dead
    const [event] = await auditEvents(w.tenantId, "user.deactivate", victim.userId);
    expect(event).toMatchObject({ reason: "Left the company", actorUserId: cityAAdmin.userId });

    expect((await call(deactivate, "POST", "/x", { cookie: adminCookie, params: { id: victim.userId }, body: { reason: "again" } })).status).toBe(409);
    expect((await call(patchUser, "PATCH", "/x", { cookie: adminCookie, params: { id: victim.userId }, body: { locale: "es-US" } })).status).toBe(409);
  });

  it("refuses self-deactivation, a missing reason, out-of-scope targets and people without users.archive", async () => {
    expect((await call(deactivate, "POST", "/x", { cookie: ceo, params: { id: w.ceo.userId }, body: { reason: "oops" } })).status).toBe(403);
    expect((await call(deactivate, "POST", "/x", { cookie: ceo, params: { id: w.techB.userId }, body: {} })).status).toBe(400);
    expect((await call(deactivate, "POST", "/x", { cookie: adminCookie, params: { id: w.techB.userId }, body: { reason: "x" } })).status).toBe(404);
    expect((await call(deactivate, "POST", "/x", { cookie: await sessionCookie(w.techA1, w.tenantId), params: { id: w.techA1Other.userId }, body: { reason: "x" } })).status).toBe(403);
    expect((await withTenant(w.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: w.techB.userId } }))).status).toBe("ACTIVE");
  });
});
