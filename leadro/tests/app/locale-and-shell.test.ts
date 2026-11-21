import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db";
import { assignRole, createTenantWithUser, resetAuthTestState, loginAs, testClient } from "../auth/auth-helpers";
import { buildWorld } from "../authz/fixtures";
import { getFakeCookie, redirectOf, resetFakeRequest, setFakeCookie, setFakeHeader } from "./next-fakes";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import RootLayout from "@/app/layout";
import { changeLocaleAction } from "@/app/_actions/locale";
import { revokeSessionAction } from "@/app/_actions/session";
import { requestPasswordResetAction } from "@/app/(auth)/forgot-password/actions";
import { acceptInvitationAction } from "@/app/(auth)/accept-invitation/actions";
import { LOCALE_COOKIE_NAME } from "@/app/_lib/locale-negotiation";
import { readSessionState } from "@/app/_lib/page-context";
import { SESSION_COOKIE_NAME, listOwnSessions } from "@/server/auth";
import HomePage from "@/app/(app)/page";
import SessionsPage from "@/app/(app)/account/sessions/page";
import SecurityPage from "@/app/(app)/account/security/page";
import { NAVIGATION_ITEMS, getNavigation } from "@/app/(app)/navigation";

resetAuthTestState();
beforeEach(resetFakeRequest);

/** Browser state of a signed-in user (the cookie the login action would have set). */
async function signInAs(user: Awaited<ReturnType<typeof createTenantWithUser>>) {
  const result = await loginAs(user);
  setFakeCookie(SESSION_COOKIE_NAME, result.token);
  return result;
}

/** The `<html>` element the root layout renders (it is an async server component). */
async function renderHtmlElement() {
  const element = (await RootLayout({ children: null })) as { props: { lang: string; dir: string } };
  return element.props;
}

describe("root layout language and direction", () => {
  it("defaults to en-US left-to-right for a visitor with no preference", async () => {
    expect(await renderHtmlElement()).toMatchObject({ lang: "en-US", dir: "ltr" });
  });

  it("uses Accept-Language when no language was chosen", async () => {
    setFakeHeader("accept-language", "he-IL,he;q=0.9,en;q=0.5");
    expect(await renderHtmlElement()).toMatchObject({ lang: "he-IL", dir: "rtl" });
  });

  it("prefers the leadro_locale cookie over Accept-Language", async () => {
    setFakeHeader("accept-language", "he-IL");
    setFakeCookie(LOCALE_COOKIE_NAME, "es-US");
    expect(await renderHtmlElement()).toMatchObject({ lang: "es-US", dir: "ltr" });
  });

  it("renders dir=rtl for a signed-in user whose locale is he-IL", async () => {
    const user = await createTenantWithUser();
    await signInAs(user);
    expect(await changeLocaleAction("he-IL")).toBe(true);
    expect(await renderHtmlElement()).toMatchObject({ lang: "he-IL", dir: "rtl" });
  });
});

describe("changeLocaleAction", () => {
  it("saves the language on the signed-in user, audits it and remembers it in a cookie", async () => {
    const user = await createTenantWithUser();
    await signInAs(user);
    expect(await changeLocaleAction("es-US")).toBe(true);

    const saved = await withTenant(user.tenantId, async (tx) => ({
      user: await tx.user.findUniqueOrThrow({ where: { id: user.userId }, select: { locale: true } }),
      audit: await tx.auditEvent.findMany({ where: { tenantId: user.tenantId, action: "user.locale_change" } }),
    }));
    expect(saved.user.locale).toBe("es-US");
    expect(saved.audit).toHaveLength(1);
    expect(saved.audit[0]).toMatchObject({ actorUserId: user.userId, targetId: user.userId });
    expect(getFakeCookie(LOCALE_COOKIE_NAME)).toBe("es-US");
  });

  it("only ever changes the caller's own record", async () => {
    const caller = await createTenantWithUser();
    const bystander = await createTenantWithUser();
    await signInAs(caller);
    await changeLocaleAction("he-IL");
    const bystanderLocale = await withTenant(bystander.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: bystander.userId }, select: { locale: true } }),
    );
    expect(bystanderLocale.locale).toBeNull();
  });

  it("only sets the cookie when nobody is signed in", async () => {
    expect(await changeLocaleAction("he-IL")).toBe(true);
    expect(getFakeCookie(LOCALE_COOKIE_NAME)).toBe("he-IL");
  });

  it("rejects unsupported locales without touching anything", async () => {
    const user = await createTenantWithUser();
    await signInAs(user);
    expect(await changeLocaleAction("fr-FR")).toBe(false);
    expect(getFakeCookie(LOCALE_COOKIE_NAME)).toBeUndefined();
  });
});

describe("navigation from permissions", () => {
  const everyItemAvailable = NAVIGATION_ITEMS.map((item) => ({ ...item, isAvailable: true }));
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

  it("shows a Technician no administration items but shows the CEO all of them", async () => {
    const world = await buildWorld("nav");
    const technician = ids(await getNavigation(world.techA1.actor, everyItemAvailable));
    const ceo = ids(await getNavigation(world.ceo.actor, everyItemAvailable));

    expect(technician).toEqual(["overview"]);
    expect(ceo).toEqual(everyItemAvailable.map((item) => item.id));
  });

  it("shows only what the granted permissions allow in between (HR sees employees, not audit)", async () => {
    const world = await buildWorld("nav-hr");
    const hr = ids(await getNavigation(world.hr.actor, everyItemAvailable));
    expect(hr).toContain("employees");
    expect(hr).not.toContain("audit");
  });

  it("never lists pages that do not exist yet, whatever the permissions", async () => {
    const world = await buildWorld("nav-planned");
    const shown = ids(await getNavigation(world.ceo.actor));
    const unbuilt = NAVIGATION_ITEMS.filter((item) => !item.isAvailable).map((item) => item.id);
    expect(unbuilt).toContain("audit");
    for (const id of unbuilt) expect(shown).not.toContain(id);
  });
});

describe("account sessions", () => {
  it("revokes another of the user's own sessions but never someone else's", async () => {
    const user = await createTenantWithUser();
    const other = await createTenantWithUser();
    await signInAs(user);
    await loginAs(user, undefined, testClient()); // a second device
    await loginAs(other);

    const mine = await listOwnSessions((await readSessionState())!.actor);
    expect(mine).toHaveLength(2);
    const target = mine.find((session) => !session.isCurrent)!;

    const forged = new FormData();
    forged.set("sessionId", "does-not-exist");
    await revokeSessionAction(forged); // no error, no effect
    const form = new FormData();
    form.set("sessionId", target.id);
    await revokeSessionAction(form);

    const after = await listOwnSessions((await readSessionState())!.actor);
    expect(after.map((session) => session.id)).toEqual(mine.filter((session) => session.isCurrent).map((session) => session.id));
  });

  it("does not revoke the current session through the revoke action (logout does that)", async () => {
    const user = await createTenantWithUser();
    await signInAs(user);
    const state = (await readSessionState())!;
    const form = new FormData();
    form.set("sessionId", state.actor.sessionId);
    await revokeSessionAction(form);
    expect(await listOwnSessions(state.actor)).toHaveLength(1);
  });
});

describe("password reset and invitations", () => {
  it("answers a reset request the same way for a real and an unknown account", async () => {
    const user = await createTenantWithUser();
    const ask = (tenantSlug: string, email: string) => {
      const form = new FormData();
      form.set("tenantSlug", tenantSlug);
      form.set("email", email);
      return requestPasswordResetAction({}, form);
    };
    const real = await ask(user.tenantSlug, user.email);
    const unknown = await ask("no-such-company", "nobody@example.test");
    expect(real.success).toBe("If an account matches, a reset link is on its way.");
    expect(unknown).toEqual(real);
  });

  it("rejects mismatched passwords and a bad invitation token with translated, non-revealing text", async () => {
    const mismatch = new FormData();
    mismatch.set("token", "abc");
    mismatch.set("password", "a long enough password 1");
    mismatch.set("confirmPassword", "something else entirely");
    expect((await acceptInvitationAction({}, mismatch)).error).toBe("The two passwords do not match.");

    const badToken = new FormData();
    badToken.set("token", "not-a-real-token");
    badToken.set("password", "a long enough password 1");
    badToken.set("confirmPassword", "a long enough password 1");
    expect((await acceptInvitationAction({}, badToken)).error).toBe(
      "This invitation link is invalid or has expired. Ask your administrator for a new one.",
    );
  });
});

describe("MFA-pending (password-only) sessions", () => {
  /** A live full session on one device, then a password-only session on another; the browser holds the latter. */
  async function pendingBrowser() {
    const user = await createTenantWithUser();
    const fullSession = await loginAs(user);
    await assignRole(user, { requiresMfa: true });
    const pending = await loginAs(user);
    expect(pending.mfaRequired).toBe(true);
    setFakeCookie(SESSION_COOKIE_NAME, pending.token);
    return { user, fullSession };
  }

  const sessionRevoked = (tenantId: string, userId: string) =>
    withTenant(tenantId, async (tx) => (await tx.session.findMany({ where: { userId, revokedAt: null } })).length);

  it("cannot revoke the user's other sessions", async () => {
    const { user } = await pendingBrowser();
    const live = await sessionRevoked(user.tenantId, user.userId);
    const target = await withTenant(user.tenantId, (tx) => tx.session.findFirstOrThrow({ where: { userId: user.userId, mfaPending: false } }));
    const form = new FormData();
    form.set("sessionId", target.id);
    expect(await redirectOf(() => revokeSessionAction(form))).toBe("/login/mfa");
    expect(await sessionRevoked(user.tenantId, user.userId)).toBe(live);
  });

  it("cannot change user.locale (only the cookie is set)", async () => {
    const { user } = await pendingBrowser();
    expect(await changeLocaleAction("he-IL")).toBe(true);
    const row = await withTenant(user.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: user.userId }, select: { locale: true } }));
    expect(row.locale).toBeNull();
  });

  it("is redirected to the MFA step by every (app) page before any data is loaded", async () => {
    await pendingBrowser();
    for (const page of [HomePage, SessionsPage, SecurityPage]) {
      expect(await redirectOf(() => page())).toBe("/login/mfa");
    }
  });

  it("sends visitors with no session to the login page from every (app) page", async () => {
    for (const page of [HomePage, SessionsPage, SecurityPage]) {
      expect(await redirectOf(() => page())).toBe("/login");
    }
  });
});
