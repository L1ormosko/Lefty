import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Decode, generateTotp, hotp, totpTimeStep } from "@/lib/totp";
import { RateLimitedError, UnauthenticatedError, ValidationError, ConflictError } from "@/server/core";
import {
  authenticateMfaRequest,
  authenticateRequest,
  confirmMfaEnrollment,
  startMfaEnrollment,
  userRequiresMfa,
  verifyMfaChallenge,
} from "@/server/auth";
import { EncryptionKeyError } from "@/server/auth/secret-box";
import { withTenant } from "@/server/db";
import {
  assignRole,
  createTenantWithUser,
  loadUser,
  loginAs,
  requestWithToken,
  resetAuthTestState,
  testClient,
  useTestEncryptionKey,
  type TestUser,
} from "./auth-helpers";

resetAuthTestState();

const originalKey = process.env.LEADRO_ENCRYPTION_KEY;
beforeAll(() => useTestEncryptionKey());
afterAll(() => {
  if (originalKey === undefined) delete process.env.LEADRO_ENCRYPTION_KEY;
  else process.env.LEADRO_ENCRYPTION_KEY = originalKey;
});

/** Logs in (MFA pending) and returns what an enrolled authenticator app would show. */
async function pendingSession(user: TestUser) {
  const login = await loginAs(user);
  const actor = await authenticateMfaRequest(requestWithToken(login.token));
  return { ...login, actor };
}

/** Enrolls the user and completes the first login; returns a function producing valid codes. */
async function enrol(user: TestUser) {
  await assignRole(user, { requiresMfa: true });
  const { actor, token } = await pendingSession(user);
  const enrollment = await startMfaEnrollment(actor, testClient());
  const secret = base32Decode(enrollment.secret);
  // Codes for the adjacent step avoid the replay guard when the test needs several valid codes.
  const codeAt = (stepOffset: number) => hotp(secret, totpTimeStep(Date.now()) + stepOffset);
  const promoted = await confirmMfaEnrollment(actor, codeAt(0), testClient());
  if (!promoted) throw new Error("expected the pending session to be promoted");
  return { actor, pendingToken: token, token: promoted.token, secret, codeAt, enrollment };
}

describe("MFA policy", () => {
  it("is required only while some ACTIVE, un-revoked, in-date assignment points at an active requiresMfa role", async () => {
    const user = await createTenantWithUser();
    const check = () => withTenant(user.tenantId, (tx) => userRequiresMfa(tx, user.tenantId, user.userId));
    expect(await check()).toBe(false);

    await assignRole(user, { requiresMfa: false });
    expect(await check()).toBe(false);
    await assignRole(user, { requiresMfa: true, active: false });
    await assignRole(user, { requiresMfa: true, revoked: true });
    await assignRole(user, { requiresMfa: true, effectiveFrom: new Date(Date.now() + 86_400_000) });
    await assignRole(user, { requiresMfa: true, effectiveTo: new Date(Date.now() - 1000) });
    expect(await check()).toBe(false);

    await assignRole(user, { requiresMfa: true, effectiveTo: new Date(Date.now() + 86_400_000) });
    expect(await check()).toBe(true);
  });

  it("does not demand MFA at login for a user without such a role", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: false });
    expect(await loginAs(user)).toMatchObject({ mfaRequired: false, mfaEnrollmentRequired: false });
  });
});

describe("MFA enrollment", () => {
  it("stores the seed encrypted, shows it once, and only enables MFA after a valid code", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: true });
    const { actor } = await pendingSession(user);
    const enrollment = await startMfaEnrollment(actor, testClient());

    expect(enrollment.otpauthUri).toMatch(/^otpauth:\/\/totp\/LEADRO:/);
    expect(enrollment.otpauthUri).toContain(`secret=${enrollment.secret}`);
    const stored = await loadUser(user);
    expect(stored.mfaEnabled).toBe(false);
    expect(stored.mfaSecretEncrypted).toMatch(/^v1:/);
    expect(stored.mfaSecretEncrypted).not.toContain(enrollment.secret);
    expect(stored.mfaSecretEncrypted).not.toContain(base32Decode(enrollment.secret).toString("base64"));

    await expect(confirmMfaEnrollment(actor, "000000", testClient())).rejects.toBeInstanceOf(ValidationError);
    expect((await loadUser(user)).mfaEnabled).toBe(false);

    const secret = base32Decode(enrollment.secret);
    await confirmMfaEnrollment(actor, generateTotp(secret, Date.now()), testClient());
    expect((await loadUser(user)).mfaEnabled).toBe(true);
    await expect(startMfaEnrollment(actor, testClient())).rejects.toBeInstanceOf(ConflictError);
  });

  it("completes the pending session when enrollment is confirmed", async () => {
    const user = await createTenantWithUser();
    const { token, pendingToken } = await enrol(user);
    await expect(authenticateRequest(requestWithToken(token))).resolves.toMatchObject({ userId: user.userId });
    // Session fixation hardening: the token used before MFA stops working once the session is promoted.
    expect(token).not.toBe(pendingToken);
    await expect(authenticateMfaRequest(requestWithToken(pendingToken))).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("refuses MFA features without LEADRO_ENCRYPTION_KEY", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: true });
    const { actor } = await pendingSession(user);
    const key = process.env.LEADRO_ENCRYPTION_KEY;
    delete process.env.LEADRO_ENCRYPTION_KEY;
    try {
      await expect(startMfaEnrollment(actor, testClient())).rejects.toBeInstanceOf(EncryptionKeyError);
      expect((await loadUser(user)).mfaSecretEncrypted).toBeNull();
    } finally {
      process.env.LEADRO_ENCRYPTION_KEY = key;
    }
  });
});

describe("MFA login path", () => {
  it("requires the second factor: password alone yields an unusable session until a code is verified", async () => {
    const user = await createTenantWithUser();
    const { secret } = await enrol(user);

    const login = await loginAs(user);
    expect(login).toMatchObject({ mfaRequired: true, mfaEnrollmentRequired: false });
    await expect(authenticateRequest(requestWithToken(login.token))).rejects.toBeInstanceOf(UnauthenticatedError);

    const actor = await authenticateMfaRequest(requestWithToken(login.token));
    // Wrong code first: refused, session still pending, failure recorded.
    await expect(verifyMfaChallenge(actor, "123456", testClient())).rejects.toBeInstanceOf(ValidationError);
    await expect(authenticateRequest(requestWithToken(login.token))).rejects.toBeInstanceOf(UnauthenticatedError);

    // The next step's code differs from the one used during enrollment (replay guard).
    const promoted = await verifyMfaChallenge(actor, hotp(secret, totpTimeStep(Date.now()) + 1), testClient());
    expect(promoted?.token).toBeTruthy();
    // The pre-MFA token is dead; the rotated one works, and the session id is unchanged.
    await expect(authenticateRequest(requestWithToken(login.token))).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(authenticateRequest(requestWithToken(promoted!.token))).resolves.toMatchObject({
      userId: user.userId,
      sessionId: actor.sessionId,
    });

    const failures = await withTenant(user.tenantId, (tx) =>
      tx.authenticationEvent.count({ where: { userId: user.userId, type: "MFA_CHALLENGE_FAILED" } }),
    );
    expect(failures).toBe(1);
  });

  it("refuses a code that was already used (replay)", async () => {
    const user = await createTenantWithUser();
    const { secret, codeAt } = await enrol(user);
    const login = await loginAs(user);
    const actor = await authenticateMfaRequest(requestWithToken(login.token));

    // codeAt(0) was consumed by the enrollment confirmation.
    await expect(verifyMfaChallenge(actor, codeAt(0), testClient())).rejects.toBeInstanceOf(ValidationError);
    // An older in-window step is refused once a newer one was accepted, so it is refused here too.
    await expect(verifyMfaChallenge(actor, hotp(secret, totpTimeStep(Date.now()) - 1), testClient())).rejects.toBeInstanceOf(ValidationError);
    const promoted = await verifyMfaChallenge(actor, codeAt(1), testClient());
    await expect(authenticateRequest(requestWithToken(promoted!.token))).resolves.toBeTruthy();
  });

  it("lets only one of two concurrent requests use the same fresh code", async () => {
    const user = await createTenantWithUser();
    const { codeAt } = await enrol(user);
    const first = await authenticateMfaRequest(requestWithToken((await loginAs(user)).token));
    const second = await authenticateMfaRequest(requestWithToken((await loginAs(user)).token));

    const results = await Promise.allSettled([
      verifyMfaChallenge(first, codeAt(1), testClient()),
      verifyMfaChallenge(second, codeAt(1), testClient()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("locks the account after 5 wrong codes, so a stolen password cannot brute-force the code", async () => {
    const user = await createTenantWithUser();
    const { codeAt } = await enrol(user);
    const login = await loginAs(user);
    const actor = await authenticateMfaRequest(requestWithToken(login.token));

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(verifyMfaChallenge(actor, "000000", testClient())).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await loadUser(user)).lockedUntil).not.toBeNull();
    // Even a valid code is now refused while locked.
    await expect(verifyMfaChallenge(actor, codeAt(1), testClient())).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("verify needs MFA to be enabled", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: true });
    const { actor } = await pendingSession(user);
    await expect(verifyMfaChallenge(actor, "123456", testClient())).rejects.toThrow(/not enabled/);
  });
});

describe("MFA required by a role granted after login", () => {
  it("sends an already-logged-in session back to the MFA step until a code is verified", async () => {
    const user = await createTenantWithUser();
    const login = await loginAs(user);
    expect(login.mfaRequired).toBe(false);
    // A normal session works...
    await expect(authenticateRequest(requestWithToken(login.token))).resolves.toMatchObject({ userId: user.userId });

    // ...until the user is given a role that requires MFA mid-session.
    await assignRole(user, { requiresMfa: true });
    await expect(authenticateRequest(requestWithToken(login.token))).rejects.toBeInstanceOf(UnauthenticatedError);
    const actor = await authenticateMfaRequest(requestWithToken(login.token));

    // The existing enrollment step promotes it and records when MFA was passed.
    const enrollment = await startMfaEnrollment(actor, testClient());
    const code = hotp(base32Decode(enrollment.secret), totpTimeStep(Date.now()));
    const promoted = await confirmMfaEnrollment(actor, code, testClient());
    if (!promoted) throw new Error("expected promotion");
    await expect(authenticateRequest(requestWithToken(promoted.token))).resolves.toMatchObject({ userId: user.userId });
    const session = await withTenant(user.tenantId, (tx) => tx.session.findUniqueOrThrow({ where: { id: actor.sessionId } }));
    expect(session.mfaVerifiedAt).not.toBeNull();
  });
});
