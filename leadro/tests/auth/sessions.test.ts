import { describe, expect, it, vi } from "vitest";
import { NotFoundError, UnauthenticatedError } from "@/server/core";
import {
  authenticateMfaRequest,
  authenticateRequest,
  deactivateUserAccount,
  listOwnSessions,
  logout,
  requireSession,
  revokeOwnSession,
} from "@/server/auth";
import { hashToken } from "@/server/auth/tokens";
import { withTenant } from "@/server/db";
import { createTenant } from "../helpers";
import {
  assignRole,
  createActiveUser,
  createTenantWithUser,
  loginAs,
  requestWithToken,
  resetAuthTestState,
  testClient,
} from "./auth-helpers";

// requireSession reads the cookie jar of the current Next.js request; stand one in.
const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "leadro_session" && cookieJar.value ? { name, value: cookieJar.value } : undefined),
  }),
}));

resetAuthTestState();

const ageSession = (tenantId: string, token: string, data: { lastSeenAt?: Date; expiresAt?: Date }) =>
  withTenant(tenantId, (tx) => tx.session.update({ where: { tokenHash: hashToken(token) }, data }));

describe("session authentication", () => {
  it("resolves the actor (tenant, user, employee, session) from the cookie", async () => {
    const user = await createTenantWithUser();
    const employee = await withTenant(user.tenantId, (tx) =>
      tx.employee.create({ data: { tenantId: user.tenantId, userId: user.userId, firstName: "Ada", lastName: "L" } }),
    );
    const { token } = await loginAs(user);

    const actor = await authenticateRequest(requestWithToken(token));
    expect(actor).toMatchObject({ tenantId: user.tenantId, userId: user.userId, employeeId: employee.id });
    expect(actor.sessionId).toBeTruthy();
  });

  it("rejects requests with no cookie, a malformed token, or a token from another tenant's namespace", async () => {
    const user = await createTenantWithUser();
    const other = await createTenantWithUser();
    const { token } = await loginAs(user);

    await expect(authenticateRequest(new Request("http://localhost/x"))).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(authenticateRequest(requestWithToken("garbage"))).rejects.toBeInstanceOf(UnauthenticatedError);
    // Same random part under another tenant id: the hash differs, so it matches nothing.
    const forged = `${other.tenantId}.${token.split(".")[1]}`;
    await expect(authenticateRequest(requestWithToken(forged))).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("enforces the idle timeout and the absolute lifetime, and audits the refusal", async () => {
    const user = await createTenantWithUser();
    const idle = await loginAs(user);
    const expired = await loginAs(user);
    await ageSession(user.tenantId, idle.token, { lastSeenAt: new Date(Date.now() - 61 * 60_000) });
    await ageSession(user.tenantId, expired.token, { expiresAt: new Date(Date.now() - 1000) });

    await expect(authenticateRequest(requestWithToken(idle.token))).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(authenticateRequest(requestWithToken(expired.token))).rejects.toBeInstanceOf(UnauthenticatedError);

    const denials = await withTenant(user.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: "auth.access_denied" }, orderBy: { occurredAt: "asc" } }),
    );
    expect(denials.map((event) => (event.newValue as { reason: string }).reason).sort()).toEqual(["expired", "idle_timeout"]);
    expect(denials.every((event) => event.outcome === "DENIED")).toBe(true);
  });

  it("slides lastSeenAt forward only when it is stale", async () => {
    const user = await createTenantWithUser();
    const { token } = await loginAs(user);
    await ageSession(user.tenantId, token, { lastSeenAt: new Date(Date.now() - 10 * 60_000) });
    await authenticateRequest(requestWithToken(token));
    const row = await withTenant(user.tenantId, (tx) => tx.session.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } }));
    expect(Date.now() - row.lastSeenAt.getTime()).toBeLessThan(60_000);
  });

  it("stops working the moment the user is deactivated, even if the session row were still live", async () => {
    const user = await createTenantWithUser();
    const { token } = await loginAs(user);
    await withTenant(user.tenantId, (tx) => tx.user.update({ where: { id: user.userId }, data: { status: "DEACTIVATED" } }));
    await expect(authenticateRequest(requestWithToken(token))).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("deactivation through the service revokes the sessions", async () => {
    const user = await createTenantWithUser();
    const { token } = await loginAs(user);
    await authenticateRequest(requestWithToken(token));
    await deactivateUserAccount(user.tenantId, user.userId, null, testClient());
    await expect(authenticateRequest(requestWithToken(token))).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("keeps an MFA-pending session out of normal routes but lets it reach the MFA routes", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: true });
    const { token, mfaRequired } = await loginAs(user);
    expect(mfaRequired).toBe(true);

    await expect(authenticateRequest(requestWithToken(token))).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(authenticateMfaRequest(requestWithToken(token))).resolves.toMatchObject({ userId: user.userId });
  });

  it("requireSession returns the actor for server components, and throws without a session", async () => {
    const user = await createTenantWithUser();
    const { token } = await loginAs(user);
    cookieJar.value = token;
    await expect(requireSession()).resolves.toMatchObject({ tenantId: user.tenantId, userId: user.userId });
    cookieJar.value = undefined;
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("logout and own-session management", () => {
  it("logout revokes the current session and records it", async () => {
    const user = await createTenantWithUser();
    const { token } = await loginAs(user);
    const actor = await authenticateRequest(requestWithToken(token));
    await logout(actor, testClient());

    await expect(authenticateRequest(requestWithToken(token))).rejects.toBeInstanceOf(UnauthenticatedError);
    const events = await withTenant(user.tenantId, (tx) => tx.authenticationEvent.count({ where: { type: "LOGOUT", userId: user.userId } }));
    expect(events).toBe(1);
  });

  it("lists only the caller's own live sessions and marks the current one", async () => {
    const tenant = await createTenant("auth-sessions");
    const me = await createActiveUser(tenant);
    const colleague = await createActiveUser(tenant);
    const first = await loginAs(me);
    const second = await loginAs(me);
    await loginAs(colleague);
    const actor = await authenticateRequest(requestWithToken(second.token));

    const before = await listOwnSessions(actor);
    expect(before).toHaveLength(2); // the colleague's session is not listed
    expect(before.filter((session) => session.isCurrent)).toHaveLength(1);
    const otherSession = before.find((session) => !session.isCurrent);
    await revokeOwnSession(actor, otherSession?.id ?? "", testClient());

    const sessions = await listOwnSessions(actor);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: actor.sessionId, isCurrent: true });
    await expect(authenticateRequest(requestWithToken(first.token))).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("cannot revoke another user's session, even in the same tenant, nor one in another tenant", async () => {
    const tenant = await createTenant("auth-revoke");
    const me = await createActiveUser(tenant);
    const colleague = await createActiveUser(tenant);
    const stranger = await createTenantWithUser();
    const mine = await authenticateRequest(requestWithToken((await loginAs(me)).token));
    const colleagueToken = (await loginAs(colleague)).token;
    const strangerToken = (await loginAs(stranger)).token;
    const colleagueSession = await authenticateRequest(requestWithToken(colleagueToken));
    const strangerSession = await authenticateRequest(requestWithToken(strangerToken));

    await expect(revokeOwnSession(mine, colleagueSession.sessionId, testClient())).rejects.toBeInstanceOf(NotFoundError);
    await expect(revokeOwnSession(mine, strangerSession.sessionId, testClient())).rejects.toBeInstanceOf(NotFoundError);
    await expect(authenticateRequest(requestWithToken(colleagueToken))).resolves.toBeTruthy();
    await expect(authenticateRequest(requestWithToken(strangerToken))).resolves.toBeTruthy();
  });
});
