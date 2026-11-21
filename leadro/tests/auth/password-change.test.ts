import { beforeEach, describe, expect, it } from "vitest";
import { POST as changePassword } from "@/app/api/v1/users/me/password/route";
import { GET as profile } from "@/app/api/v1/users/me/route";
import { login, resetRateLimits } from "@/server/auth";
import { withTenant } from "@/server/db";
import { call } from "../org/org-helpers";
import { createTenantWithUser, loginAs, resetAuthTestState, testClient, TEST_PASSWORD } from "./auth-helpers";

resetAuthTestState();
beforeEach(() => resetRateLimits());

const NEW_PASSWORD = "an entirely new passphrase";
const cookieOf = (token: string) => `leadro_session=${token}`;

async function twoSessions() {
  const user = await createTenantWithUser();
  const current = await loginAs(user);
  const other = await loginAs(user);
  return { user, current, other };
}

describe("changing your own password", () => {
  it("needs the current password, switches the credential, and signs out the OTHER sessions only", async () => {
    const { user, current, other } = await twoSessions();
    const result = await call(changePassword, "POST", "/api/v1/users/me/password", {
      cookie: cookieOf(current.token),
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(result.status).toBe(200);
    expect(result.json.data).toEqual({ revokedSessions: 1 });

    // the session that made the request survives, the other one is gone
    expect((await call(profile, "GET", "/x", { cookie: cookieOf(current.token) })).status).toBe(200);
    expect((await call(profile, "GET", "/x", { cookie: cookieOf(other.token) })).status).toBe(401);

    await expect(login({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD }, testClient())).rejects.toBeTruthy();
    await expect(login({ tenantSlug: user.tenantSlug, email: user.email, password: NEW_PASSWORD }, testClient())).resolves.toBeTruthy();

    const events = await withTenant(user.tenantId, (tx) => tx.authenticationEvent.findMany({ where: { userId: user.userId, type: "PASSWORD_CHANGED" } }));
    expect(events).toHaveLength(1);
    const audit = await withTenant(user.tenantId, (tx) => tx.auditEvent.findMany({ where: { action: "auth.password_change", actorUserId: user.userId } }));
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(audit)).not.toContain(TEST_PASSWORD);
  });

  it("rejects a wrong current password without changing anything", async () => {
    const { user, current, other } = await twoSessions();
    const result = await call(changePassword, "POST", "/x", {
      cookie: cookieOf(current.token),
      body: { currentPassword: "not the password!!", newPassword: NEW_PASSWORD },
    });
    expect(result.status).toBe(400);
    expect(result.json.error.field).toBe("currentPassword");
    expect((await call(profile, "GET", "/x", { cookie: cookieOf(other.token) })).status).toBe(200); // nobody was signed out
    await expect(login({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD }, testClient())).resolves.toBeTruthy();
  });

  it("enforces the password policy and refuses an unchanged password", async () => {
    const { current } = await twoSessions();
    const cookie = cookieOf(current.token);
    const short = await call(changePassword, "POST", "/x", { cookie, body: { currentPassword: TEST_PASSWORD, newPassword: "short" } });
    expect(short.status).toBe(400);
    expect(short.json.error.field).toBe("password");
    const same = await call(changePassword, "POST", "/x", { cookie, body: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD } });
    expect(same.status).toBe(400);
    expect(same.json.error.field).toBe("newPassword");
  });

  it("is throttled per account (it is a password oracle for a hijacked session)", async () => {
    const { current } = await twoSessions();
    const cookie = cookieOf(current.token);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await call(changePassword, "POST", "/x", { cookie, body: { currentPassword: "wrong wrong wrong", newPassword: NEW_PASSWORD } })).status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 400)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("requires a session and a valid body", async () => {
    expect((await call(changePassword, "POST", "/x", { body: { currentPassword: "a", newPassword: "b" } })).status).toBe(401);
    const { current } = await twoSessions();
    expect((await call(changePassword, "POST", "/x", { cookie: cookieOf(current.token), body: { currentPassword: "a" } })).status).toBe(400);
  });
});

describe("own profile", () => {
  it("returns only non-secret fields", async () => {
    const { user, current } = await twoSessions();
    const result = await call(profile, "GET", "/api/v1/users/me", { cookie: cookieOf(current.token) });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({ id: user.userId, email: user.email, status: "ACTIVE" });
    const text = JSON.stringify(result.json);
    for (const secret of ["passwordHash", "mfaSecret", "failedLoginCount", "lockedUntil"]) expect(text).not.toContain(secret);
  });
});
