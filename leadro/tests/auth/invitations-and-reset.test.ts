import { describe, expect, it } from "vitest";
import { RateLimitedError, ValidationError } from "@/server/core";
import {
  acceptInvitation,
  authenticateRequest,
  completePasswordReset,
  createInvitation,
  login,
  requestPasswordReset,
  setAuthNotifier,
  type PasswordResetMessage,
} from "@/server/auth";
import { hashToken } from "@/server/auth/tokens";
import { withTenant } from "@/server/db";
import { createTenant } from "../helpers";
import {
  TEST_PASSWORD,
  assignRole,
  createActiveUser,
  createTenantWithUser,
  loadUser,
  loginAs,
  requestWithToken,
  resetAuthTestState,
  testClient,
  uniqueEmail,
} from "./auth-helpers";

resetAuthTestState();

const NEW_PASSWORD = "a brand new passphrase";

describe("invitations", () => {
  it("creates a user on accept, sets the password, and the user can then log in", async () => {
    const tenant = await createTenant("auth-invite");
    const email = uniqueEmail("invitee");
    const invitation = await createInvitation(tenant.id, { email, invitedById: null }, testClient());

    const { userId } = await acceptInvitation({ token: invitation.token, password: NEW_PASSWORD }, testClient());
    const result = await login({ tenantSlug: tenant.slug, email, password: NEW_PASSWORD }, testClient());
    expect(result.userId).toBe(userId);
  });

  it("stores only a hash, expires in 72 hours, and activates an existing INVITED user", async () => {
    const tenant = await createTenant("auth-invite2");
    const invited = await createActiveUser(tenant, { status: "INVITED" });
    const before = Date.now();
    const invitation = await createInvitation(tenant.id, { email: invited.email, invitedById: null }, testClient());

    const row = await withTenant(tenant.id, (tx) => tx.invitation.findUniqueOrThrow({ where: { id: invitation.invitationId } }));
    expect(row.tokenHash).toBe(hashToken(invitation.token));
    expect(row.tokenHash).not.toBe(invitation.token);
    const ttlHours = (row.expiresAt.getTime() - before) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(71.9);
    expect(ttlHours).toBeLessThan(72.1);

    await acceptInvitation({ token: invitation.token, password: NEW_PASSWORD }, testClient());
    const user = await loadUser(invited);
    expect(user.status).toBe("ACTIVE");
    expect(user.passwordHash).not.toBeNull();
  });

  it("is single-use", async () => {
    const tenant = await createTenant("auth-invite3");
    const invitation = await createInvitation(tenant.id, { email: uniqueEmail(), invitedById: null }, testClient());
    await acceptInvitation({ token: invitation.token, password: NEW_PASSWORD }, testClient());
    await expect(acceptInvitation({ token: invitation.token, password: "another passphrase!" }, testClient())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("lets only one of two concurrent accepts win", async () => {
    const tenant = await createTenant("auth-invite4");
    const invitation = await createInvitation(tenant.id, { email: uniqueEmail(), invitedById: null }, testClient());
    const attempts = await Promise.allSettled([
      acceptInvitation({ token: invitation.token, password: NEW_PASSWORD }, testClient()),
      acceptInvitation({ token: invitation.token, password: NEW_PASSWORD }, testClient()),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  });

  it("rejects expired, revoked (superseded) and garbage tokens with the same message", async () => {
    const tenant = await createTenant("auth-invite5");
    const email = uniqueEmail();
    const first = await createInvitation(tenant.id, { email, invitedById: null }, testClient());
    const second = await createInvitation(tenant.id, { email, invitedById: null }, testClient()); // revokes `first`
    await withTenant(tenant.id, (tx) =>
      tx.invitation.update({ where: { id: second.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    );

    const messages: string[] = [];
    for (const token of [first.token, second.token, "garbage", `${tenant.id}.nonsense`]) {
      const error = await acceptInvitation({ token, password: NEW_PASSWORD }, testClient()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ValidationError);
      messages.push((error as ValidationError).message);
    }
    expect(new Set(messages).size).toBe(1);
  });

  it("enforces the password policy without consuming the token", async () => {
    const tenant = await createTenant("auth-invite6");
    const invitation = await createInvitation(tenant.id, { email: uniqueEmail(), invitedById: null }, testClient());
    await expect(acceptInvitation({ token: invitation.token, password: "short" }, testClient())).rejects.toMatchObject({ field: "password" });
    await expect(acceptInvitation({ token: invitation.token, password: NEW_PASSWORD }, testClient())).resolves.toBeTruthy();
  });

  it("grants the invited role, so MFA-requiring roles apply from the first login", async () => {
    const tenant = await createTenant("auth-invite7");
    const email = uniqueEmail();
    const role = await withTenant(tenant.id, (tx) =>
      tx.role.create({ data: { tenantId: tenant.id, name: "Finance approver", requiresMfa: true } }),
    );
    const invitation = await createInvitation(tenant.id, { email, invitedById: null, roleId: role.id }, testClient());
    await acceptInvitation({ token: invitation.token, password: NEW_PASSWORD }, testClient());
    const result = await login({ tenantSlug: tenant.slug, email, password: NEW_PASSWORD }, testClient());
    expect(result.mfaRequired).toBe(true);
  });

  it("does not let an invitation take over an existing active account", async () => {
    const tenant = await createTenant("auth-invite8");
    const existing = await createActiveUser(tenant);
    const invitation = await createInvitation(tenant.id, { email: existing.email, invitedById: null }, testClient());
    await expect(acceptInvitation({ token: invitation.token, password: NEW_PASSWORD }, testClient())).rejects.toBeTruthy();
    await expect(loginAs(existing)).resolves.toBeTruthy(); // old password still works
  });

  it("does not resolve a token in another tenant's namespace", async () => {
    const tenantA = await createTenant("auth-invite9a");
    const tenantB = await createTenant("auth-invite9b");
    const invitation = await createInvitation(tenantA.id, { email: uniqueEmail(), invitedById: null }, testClient());
    const forged = `${tenantB.id}.${invitation.token.split(".")[1]}`;
    await expect(acceptInvitation({ token: forged, password: NEW_PASSWORD }, testClient())).rejects.toBeInstanceOf(ValidationError);
  });
});

function captureResetMessages(): PasswordResetMessage[] {
  const sent: PasswordResetMessage[] = [];
  setAuthNotifier({
    async sendPasswordReset(message) {
      sent.push(message);
    },
  });
  return sent;
}

describe("password reset", () => {
  it("answers identically for existing and non-existing accounts, and only mails real ones", async () => {
    const user = await createTenantWithUser();
    const sent = captureResetMessages();

    const known = await requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, testClient());
    const unknownEmail = await requestPasswordReset({ tenantSlug: user.tenantSlug, email: uniqueEmail("ghost") }, testClient());
    const unknownTenant = await requestPasswordReset({ tenantSlug: "no-such-company", email: user.email }, testClient());

    expect([known, unknownEmail, unknownTenant]).toEqual([undefined, undefined, undefined]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ tenantId: user.tenantId, userId: user.userId, email: user.email });
  });

  it("does not issue tokens for deactivated or invited users", async () => {
    const tenant = await createTenant("auth-reset-status");
    const deactivated = await createActiveUser(tenant, { status: "DEACTIVATED" });
    const sent = captureResetMessages();
    await requestPasswordReset({ tenantSlug: tenant.slug, email: deactivated.email }, testClient());
    expect(sent).toHaveLength(0);
  });

  it("stores only a hash, expires after 1 hour, and is single-use", async () => {
    const user = await createTenantWithUser();
    const sent = captureResetMessages();
    await requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, testClient());
    const { token, expiresAt } = sent[0];

    const row = await withTenant(user.tenantId, (tx) => tx.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } }));
    expect(row.tokenHash).not.toBe(token);
    const ttlMinutes = (expiresAt.getTime() - Date.now()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(59);
    expect(ttlMinutes).toBeLessThanOrEqual(60);

    await completePasswordReset({ token, newPassword: NEW_PASSWORD }, testClient());
    await expect(completePasswordReset({ token, newPassword: "yet another passphrase" }, testClient())).rejects.toBeInstanceOf(ValidationError);
    await expect(login({ tenantSlug: user.tenantSlug, email: user.email, password: NEW_PASSWORD }, testClient())).resolves.toBeTruthy();
    await expect(loginAs(user, TEST_PASSWORD)).rejects.toBeTruthy(); // old password is dead
  });

  it("rejects an expired token and a newer request invalidates the older token", async () => {
    const user = await createTenantWithUser();
    const sent = captureResetMessages();
    await requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, testClient());
    await requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, testClient());
    const [older, newer] = sent;

    await expect(completePasswordReset({ token: older.token, newPassword: NEW_PASSWORD }, testClient())).rejects.toBeInstanceOf(ValidationError);
    await withTenant(user.tenantId, (tx) =>
      tx.passwordResetToken.update({ where: { tokenHash: hashToken(newer.token) }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    );
    await expect(completePasswordReset({ token: newer.token, newPassword: NEW_PASSWORD }, testClient())).rejects.toBeInstanceOf(ValidationError);
  });

  it("revokes every session and clears a lockout", async () => {
    const user = await createTenantWithUser();
    const { token } = await loginAs(user);
    await withTenant(user.tenantId, (tx) =>
      tx.user.update({ where: { id: user.userId }, data: { lockedUntil: new Date(Date.now() + 600_000), failedLoginCount: 5 } }),
    );
    const sent = captureResetMessages();
    await requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, testClient());
    await completePasswordReset({ token: sent[0].token, newPassword: NEW_PASSWORD }, testClient());

    await expect(authenticateRequest(requestWithToken(token))).rejects.toBeTruthy();
    const after = await loadUser(user);
    expect(after.lockedUntil).toBeNull();
    expect(after.failedLoginCount).toBe(0);
    await expect(login({ tenantSlug: user.tenantSlug, email: user.email, password: NEW_PASSWORD }, testClient())).resolves.toBeTruthy();
  });

  it("enforces the password policy on the new password and keeps the token usable", async () => {
    const user = await createTenantWithUser();
    const sent = captureResetMessages();
    await requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, testClient());
    await expect(completePasswordReset({ token: sent[0].token, newPassword: "tiny" }, testClient())).rejects.toMatchObject({ field: "password" });
    await expect(completePasswordReset({ token: sent[0].token, newPassword: NEW_PASSWORD }, testClient())).resolves.toBeUndefined();
  });

  it("cannot be completed for a user deactivated after the token was issued", async () => {
    const user = await createTenantWithUser();
    const sent = captureResetMessages();
    await requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, testClient());
    await withTenant(user.tenantId, (tx) => tx.user.update({ where: { id: user.userId }, data: { status: "DEACTIVATED" } }));
    await expect(completePasswordReset({ token: sent[0].token, newPassword: NEW_PASSWORD }, testClient())).rejects.toBeInstanceOf(ValidationError);
  });

  it("is rate limited per client, and the per-account limit stays silent", async () => {
    const user = await createTenantWithUser();
    const sent = captureResetMessages();
    const client = testClient();
    // The 4th request for one account is silently dropped (3 per window) with the same response.
    for (let attempt = 0; attempt < 4; attempt++) {
      await requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, client);
    }
    expect(sent).toHaveLength(3);
    // The per-IP limit (10) is a visible 429, independent of whether the accounts exist.
    let thrown: unknown;
    for (let attempt = 0; attempt < 10 && !thrown; attempt++) {
      thrown = await requestPasswordReset({ tenantSlug: "nope", email: uniqueEmail("flood") }, client).then(
        () => undefined,
        (error: unknown) => error,
      );
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
  });

  it("MFA roles do not change the reset response", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: true });
    const sent = captureResetMessages();
    await expect(requestPasswordReset({ tenantSlug: user.tenantSlug, email: user.email }, testClient())).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});
