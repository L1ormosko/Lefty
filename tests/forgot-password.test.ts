import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, makeUser, prisma } from "./factories";

/**
 * What the reset form is allowed to say.
 *
 * Two properties pull in opposite directions and both have to hold:
 *
 * - It must not reveal whether an address has an account. That is why the
 *   answer for a registered address and an unregistered one is the same
 *   sentence.
 * - It must not claim to have sent something it cannot send. Without a
 *   provider the old code said "we have sent you a link" to everyone, which
 *   satisfied the first property by being uniformly false.
 *
 * The resolution: the unavailable message is about the platform, not the
 * address, so it is identical for every caller and gives nothing away.
 *
 * The e2e suite covers the no-provider case on the rendered page; here the
 * provider is simulated so the enumeration property can be checked, which is
 * impossible in an environment that has no mail account.
 */

const clientKeyHeaders = { get: () => "127.0.0.1" };
vi.mock("next/headers", () => ({ headers: async () => clientKeyHeaders }));

const { forgotPasswordAction } = await import("@/app/(auth)/actions");

const KEYS = ["RESEND_API_KEY", "EMAIL_FROM"] as const;
const saved: Record<string, string | undefined> = {};

const form = (email: string) => {
  const data = new FormData();
  data.set("email", email);
  return data;
};

beforeEach(async () => {
  await cleanup();
  for (const key of KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanup();
});

describe("with no email provider", () => {
  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it("says it cannot send, rather than that it did", async () => {
    const user = await makeUser();
    const res = await forgotPasswordAction(undefined, form(user.email));

    expect(res?.error).toContain("אינו פעיל");
    expect(res?.success).toBeUndefined();
  });

  it("says exactly the same thing to an address that has no account", async () => {
    const user = await makeUser();
    const registered = await forgotPasswordAction(undefined, form(user.email));
    const unknown = await forgotPasswordAction(undefined, form("nobody@velto-test.local"));

    // The message is a fact about the deployment. It cannot differ by
    // account, which is what makes saying it safe.
    expect(unknown).toEqual(registered);
  });

  it("mints no token it could never deliver", async () => {
    const user = await makeUser();
    await forgotPasswordAction(undefined, form(user.email));

    // A reset token is a credential. Creating one that nothing will ever send
    // leaves a live key sitting in the database for half an hour.
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("with a provider configured", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "velto@example.com";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "1" }), { status: 200 }) as never
    );
  });

  it("answers a registered and an unregistered address identically", async () => {
    const user = await makeUser();
    const registered = await forgotPasswordAction(undefined, form(user.email));
    const unknown = await forgotPasswordAction(undefined, form("nobody@velto-test.local"));

    expect(registered?.success).toContain("אם הכתובת רשומה");
    expect(unknown).toEqual(registered);
  });

  it("issues a token only for an address that exists", async () => {
    const user = await makeUser();
    await forgotPasswordAction(undefined, form(user.email));
    await forgotPasswordAction(undefined, form("nobody@velto-test.local"));

    // Identical on screen, different in the database - which is the only
    // place the difference is allowed to show.
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });
});
