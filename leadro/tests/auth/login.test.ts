import { describe, expect, it } from "vitest";
import { UnauthenticatedError, RateLimitedError } from "@/server/core";
import { deactivateUserAccount, login } from "@/server/auth";
import { hashToken } from "@/server/auth/tokens";
import { prisma, withTenant } from "@/server/db";
import { createTenant } from "../helpers";
import {
  TEST_PASSWORD,
  countEvents,
  createActiveUser,
  createTenantWithUser,
  loadUser,
  loginAs,
  resetAuthTestState,
  testClient,
  uniqueEmail,
} from "./auth-helpers";

resetAuthTestState();

const failedMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UnauthenticatedError);
  return (error as UnauthenticatedError).message;
};

describe("login", () => {
  it("creates a session and stores only the SHA-256 hash of the token", async () => {
    const user = await createTenantWithUser();
    const result = await loginAs(user);
    expect(result.mfaRequired).toBe(false);

    const sessions = await withTenant(user.tenantId, (tx) => tx.session.findMany({ where: { userId: user.userId } }));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tokenHash).toBe(hashToken(result.token));
    expect(sessions[0].tokenHash).not.toContain(result.token);
    expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await countEvents(user.tenantId, "LOGIN_SUCCEEDED", user.userId)).toBe(1);
    expect((await loadUser(user)).lastLoginAt).not.toBeNull();
  });

  it("gives the identical error for unknown company, unknown email and wrong password", async () => {
    const user = await createTenantWithUser();
    const client = testClient();
    const messages = [
      await failedMessage(login({ tenantSlug: "no-such-company", email: user.email, password: TEST_PASSWORD }, client)),
      await failedMessage(login({ tenantSlug: user.tenantSlug, email: uniqueEmail("ghost"), password: TEST_PASSWORD }, client)),
      await failedMessage(login({ tenantSlug: user.tenantSlug, email: user.email, password: "wrong password here" }, client)),
    ];
    expect(new Set(messages).size).toBe(1);
  });

  it("records failures (with the real reason) in login history and audit, but not for unknown companies", async () => {
    const user = await createTenantWithUser();
    await failedMessage(loginAs(user, "wrong password here"));
    await failedMessage(login({ tenantSlug: user.tenantSlug, email: uniqueEmail("ghost"), password: "x" }, testClient()));

    const events = await withTenant(user.tenantId, (tx) =>
      tx.authenticationEvent.findMany({ where: { type: "LOGIN_FAILED" }, orderBy: { occurredAt: "asc" } }),
    );
    expect(events.map((event) => (event.metadata as { reason: string }).reason)).toEqual(["bad_password", "unknown_user"]);
    expect(events[0].userId).toBe(user.userId);
    expect(events[1].userId).toBeNull();

    const audits = await withTenant(user.tenantId, (tx) =>
      tx.auditEvent.count({ where: { action: "auth.login", outcome: "FAILED" } }),
    );
    expect(audits).toBe(2);
  });

  it("normalises email case and surrounding spaces", async () => {
    const user = await createTenantWithUser();
    const result = await login(
      { tenantSlug: ` ${user.tenantSlug.toUpperCase()} `, email: `  ${user.email.toUpperCase()} `, password: TEST_PASSWORD },
      testClient(),
    );
    expect(result.userId).toBe(user.userId);
  });

  it("logs the same email in to the right tenant only", async () => {
    const tenantA = await createTenant("auth-a");
    const tenantB = await createTenant("auth-b");
    const sharedEmail = uniqueEmail("shared");
    const userA = await createActiveUser(tenantA, { email: sharedEmail });
    const userB = await createActiveUser(tenantB, { email: sharedEmail });

    const resultA = await loginAs(userA);
    const resultB = await loginAs(userB);
    expect(resultA.userId).toBe(userA.userId);
    expect(resultB.userId).toBe(userB.userId);
    expect(resultA.userId).not.toBe(resultB.userId);

    // A tenant-B user's password is not accepted under tenant A's company code with another email.
    const onlyInB = await createActiveUser(tenantB, { email: uniqueEmail("only-b") });
    await failedMessage(login({ tenantSlug: tenantA.slug, email: onlyInB.email, password: TEST_PASSWORD }, testClient()));
    // The session of A is scoped to tenant A.
    const sessionA = await withTenant(tenantA.id, (tx) => tx.session.findMany({ where: { userId: userA.userId } }));
    expect(sessionA[0].tenantId).toBe(tenantA.id);
  });

  it("refuses users that are invited (no password), deactivated, or in a suspended tenant", async () => {
    const tenant = await createTenant("auth-status");
    const invited = await createActiveUser(tenant, { status: "INVITED" });
    const deactivated = await createActiveUser(tenant, { status: "DEACTIVATED" });
    await failedMessage(loginAs(invited));
    await failedMessage(loginAs(deactivated));

    const active = await createActiveUser(tenant);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { status: "SUSPENDED" } });
    await failedMessage(loginAs(active));
  });

  it("throttles repeated attempts from one client with RATE_LIMITED", async () => {
    const user = await createTenantWithUser();
    const client = testClient({ ipAddress: "203.0.113.9" });
    let thrown: unknown;
    for (let attempt = 0; attempt < 40 && !thrown; attempt++) {
      thrown = await login({ tenantSlug: "nope", email: uniqueEmail("flood"), password: "x" }, client).catch((error: unknown) =>
        error instanceof RateLimitedError ? error : undefined,
      );
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect((thrown as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    expect(user.tenantId).toBeTruthy();
  });
});

describe("account lockout", () => {
  it("locks after 5 failed attempts, and then even the right password is refused", async () => {
    const user = await createTenantWithUser();
    for (let attempt = 0; attempt < 5; attempt++) await failedMessage(loginAs(user, "wrong password here"));

    const locked = await loadUser(user);
    expect(locked.failedLoginCount).toBe(5);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(await countEvents(user.tenantId, "ACCOUNT_LOCKED", user.userId)).toBe(1);

    await failedMessage(loginAs(user, TEST_PASSWORD));
    expect(await countEvents(user.tenantId, "LOGIN_SUCCEEDED", user.userId)).toBe(0);
  });

  it("does not lock after 4 failures, and a success resets the count", async () => {
    const user = await createTenantWithUser();
    for (let attempt = 0; attempt < 4; attempt++) await failedMessage(loginAs(user, "wrong password here"));
    await loginAs(user);
    expect((await loadUser(user)).failedLoginCount).toBe(0);

    // The four earlier failures no longer count: four more still do not lock.
    for (let attempt = 0; attempt < 4; attempt++) await failedMessage(loginAs(user, "wrong password here"));
    await loginAs(user);
    expect((await loadUser(user)).lockedUntil).toBeNull();
  });

  it("allows login again after the lock period and does not re-lock on the first new failure", async () => {
    const user = await createTenantWithUser();
    for (let attempt = 0; attempt < 5; attempt++) await failedMessage(loginAs(user, "wrong password here"));
    await failedMessage(loginAs(user, "wrong password here")); // an attempt during the lock

    // Fast-forward: the history moves 10 minutes back and the lock ended a minute ago. The failures
    // are still inside the 15 minute window but precede the lock's end, so they must not count.
    await withTenant(user.tenantId, async (tx) => {
      await tx.$executeRaw`UPDATE "AuthenticationEvent" SET "occurredAt" = "occurredAt" - interval '10 minutes' WHERE "userId" = ${user.userId}`;
      await tx.user.update({ where: { id: user.userId }, data: { lockedUntil: new Date(Date.now() - 60_000) } });
    });
    await failedMessage(loginAs(user, "wrong password here")); // 1 fresh failure
    expect((await loadUser(user)).lockedUntil!.getTime()).toBeLessThan(Date.now());
    const result = await loginAs(user);
    expect(result.userId).toBe(user.userId);
  });

  it("only counts failures inside the 15 minute window", async () => {
    const user = await createTenantWithUser();
    for (let attempt = 0; attempt < 4; attempt++) await failedMessage(loginAs(user, "wrong password here"));
    // Make those four failures 20 minutes old.
    await withTenant(user.tenantId, (tx) =>
      tx.$executeRaw`UPDATE "AuthenticationEvent" SET "occurredAt" = now() - interval '20 minutes' WHERE "userId" = ${user.userId}`,
    );
    await failedMessage(loginAs(user, "wrong password here"));
    expect((await loadUser(user)).lockedUntil).toBeNull();
    expect((await loadUser(user)).failedLoginCount).toBe(1);
  });
});

describe("deactivation", () => {
  it("revokes all sessions at once and blocks further login", async () => {
    const user = await createTenantWithUser();
    await loginAs(user);
    await loginAs(user);

    const outcome = await deactivateUserAccount(user.tenantId, user.userId, null, testClient(), "left the company");
    expect(outcome.revokedSessions).toBe(2);

    const live = await withTenant(user.tenantId, (tx) => tx.session.count({ where: { userId: user.userId, revokedAt: null } }));
    expect(live).toBe(0);
    expect((await loadUser(user)).status).toBe("DEACTIVATED");
    await failedMessage(loginAs(user));
  });
});
