import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { base32Decode, hotp, totpTimeStep } from "@/lib/totp";
import { SESSION_COOKIE_NAME } from "@/server/auth";
import { withTenant } from "@/server/db";
import { createTenantWithUser, assignRole, TEST_PASSWORD, resetAuthTestState, useTestEncryptionKey, loadUser } from "../auth/auth-helpers";
import {
  getFakeCookie,
  getFakeCookieOptions,
  redirectOf,
  resetFakeRequest,
  setFakeCookie,
} from "./next-fakes";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import { loginAction } from "@/app/(auth)/login/actions";
import { confirmMfaEnrollmentAction, startMfaEnrollmentAction, verifyMfaAction } from "@/app/_actions/mfa";
import { logoutAction } from "@/app/_actions/session";
import AppLayout from "@/app/(app)/layout";
import { readSessionState } from "@/app/_lib/page-context";
import { LOCALE_COOKIE_NAME } from "@/app/_lib/locale-negotiation";

resetAuthTestState();
beforeEach(resetFakeRequest);

const originalKey = process.env.LEADRO_ENCRYPTION_KEY;
beforeAll(() => useTestEncryptionKey());
afterAll(() => {
  if (originalKey === undefined) delete process.env.LEADRO_ENCRYPTION_KEY;
  else process.env.LEADRO_ENCRYPTION_KEY = originalKey;
});

function loginForm(fields: { tenantSlug: string; email: string; password: string }): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

function codeForm(code: string): FormData {
  const form = new FormData();
  form.set("code", code);
  return form;
}

describe("loginAction", () => {
  it("signs in a user without MFA, sets an HttpOnly session cookie and goes to the workspace", async () => {
    const user = await createTenantWithUser();
    const destination = await redirectOf(() =>
      loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD })),
    );
    expect(destination).toBe("/");
    expect(getFakeCookie(SESSION_COOKIE_NAME)).toBeTruthy();
    expect(getFakeCookieOptions(SESSION_COOKIE_NAME)).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(await readSessionState()).toMatchObject({ mfaPending: false, actor: { userId: user.userId } });
  });

  it("sends a user whose role requires MFA to the MFA step, and the app shell keeps them out until it is done", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: true });
    const destination = await redirectOf(() =>
      loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD })),
    );
    expect(destination).toBe("/login/mfa");
    expect(await readSessionState()).toMatchObject({ mfaPending: true });
    expect(await redirectOf(() => AppLayout({ children: null }))).toBe("/login/mfa");
  });

  it("renders MFA-pending pages without writing a false DENIED audit row", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: true });
    await redirectOf(() => loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD })));
    await readSessionState();
    await redirectOf(() => AppLayout({ children: null }));
    const denied = await withTenant(user.tenantId, (tx) => tx.auditEvent.findMany({ where: { tenantId: user.tenantId, outcome: "DENIED" } }));
    expect(denied).toHaveLength(0);
  });

  it("gives the same generic message for a wrong password and an unknown company (no enumeration)", async () => {
    const user = await createTenantWithUser();
    const wrongPassword = await loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: "not the password" }));
    const unknownCompany = await loginAction({}, loginForm({ tenantSlug: "no-such-company", email: user.email, password: TEST_PASSWORD }));
    expect(wrongPassword.error).toBe("The company code, email or password is incorrect.");
    expect(unknownCompany.error).toBe(wrongPassword.error);
    expect(getFakeCookie(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("shows the same generic message for a locked-out account, even with the right password", async () => {
    const user = await createTenantWithUser();
    const attempt = (password: string) =>
      loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password }));
    for (let i = 0; i < 5; i++) await attempt("wrong password " + i);
    expect((await loadUser(user)).lockedUntil).not.toBeNull();
    const locked = await attempt(TEST_PASSWORD);
    expect(locked.error).toBe("The company code, email or password is incorrect.");
    expect(getFakeCookie(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("shows the failure message in the visitor's language", async () => {
    const user = await createTenantWithUser();
    setFakeCookie(LOCALE_COOKIE_NAME, "es-US");
    const result = await loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: "wrong" }));
    expect(result.error).toBe("El código de la empresa, el correo electrónico o la contraseña son incorrectos.");
  });

  it("asks for all fields when one is empty", async () => {
    const result = await loginAction({}, loginForm({ tenantSlug: "", email: "a@b.c", password: "x" }));
    expect(result.error).toBe("Please fill in all fields.");
  });
});

describe("app shell session gate", () => {
  it("redirects to the login page when there is no session", async () => {
    expect(await redirectOf(() => AppLayout({ children: null }))).toBe("/login");
  });

  it("redirects to the login page after logout", async () => {
    const user = await createTenantWithUser();
    await redirectOf(() => loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD })));
    expect(await redirectOf(logoutAction)).toBe("/login");
    expect(getFakeCookie(SESSION_COOKIE_NAME)).toBeUndefined();
    expect(await redirectOf(() => AppLayout({ children: null }))).toBe("/login");
  });
});

describe("MFA actions", () => {
  it("enrolls on first login, rotates the session token, and a later login needs a code", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: true });
    await redirectOf(() => loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD })));
    const pendingToken = getFakeCookie(SESSION_COOKIE_NAME);

    const started = await startMfaEnrollmentAction();
    expect(started.secret).toMatch(/^[A-Z2-7]+$/);
    expect(started.otpauthUri).toContain("otpauth://totp/");
    const secret = base32Decode(started.secret!);

    const wrong = await confirmMfaEnrollmentAction({}, codeForm("000000"));
    expect(wrong.error).toBe("The verification code is not valid. Check the code and try again.");

    const destination = await redirectOf(() => confirmMfaEnrollmentAction({}, codeForm(hotp(secret, totpTimeStep(Date.now())))));
    expect(destination).toBe("/");
    expect(getFakeCookie(SESSION_COOKIE_NAME)).not.toBe(pendingToken);
    expect(await readSessionState()).toMatchObject({ mfaPending: false });
    expect((await loadUser(user)).mfaEnabled).toBe(true);

    // Second login: the authenticator exists, so the challenge (not enrollment) applies.
    resetFakeRequest();
    expect(await redirectOf(() => loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD })))).toBe("/login/mfa");
    const rejected = await verifyMfaAction({}, codeForm("123456"));
    expect(rejected.error).toBe("The verification code is not valid. Check the code and try again.");
    expect(await redirectOf(() => verifyMfaAction({}, codeForm(hotp(secret, totpTimeStep(Date.now()) + 1))))).toBe("/");
    expect(await readSessionState()).toMatchObject({ mfaPending: false });
  });

  it("shows the secret as text only and refuses to enroll twice", async () => {
    const user = await createTenantWithUser();
    await assignRole(user, { requiresMfa: false });
    await redirectOf(() => loginAction({}, loginForm({ tenantSlug: user.tenantSlug, email: user.email, password: TEST_PASSWORD })));
    const started = await startMfaEnrollmentAction();
    const secret = base32Decode(started.secret!);
    const confirmed = await confirmMfaEnrollmentAction({}, codeForm(hotp(secret, totpTimeStep(Date.now()))));
    expect(confirmed.success).toBe("Two-step verification is now enabled.");
    const again = await startMfaEnrollmentAction();
    expect(again.secret).toBeUndefined();
    expect(again.error).toBe("Two-step verification is already enabled.");
  });
});
