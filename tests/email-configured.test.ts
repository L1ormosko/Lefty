import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailConfigured, sendEmail } from "@/server/email";

/**
 * "We have sent you a link" has to be true.
 *
 * Without RESEND_API_KEY, sendEmail writes a console warning and returns -
 * correct for a notification, because the notification is in the database and
 * the user will see it when they log in. For a password reset it was a lie
 * with consequences: the message is the only thing that exists, so somebody
 * who had forgotten their password was told to go and wait for an email that
 * was never going to arrive, with no other way into their account.
 */

const KEYS = ["RESEND_API_KEY", "EMAIL_FROM"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("emailConfigured", () => {
  it("is false when the provider is not set up", () => {
    expect(emailConfigured({})).toBe(false);
  });

  it("needs both halves", () => {
    // A key with no From address produces a 4xx from Resend, which is a
    // silent failure in exactly the same way.
    expect(emailConfigured({ RESEND_API_KEY: "re_x" })).toBe(false);
    expect(emailConfigured({ EMAIL_FROM: "a@b.com" })).toBe(false);
    expect(emailConfigured({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.com" })).toBe(true);
  });

});

describe("sendEmail", () => {
  it("reports that nothing was sent rather than pretending", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sendEmail({ to: "a@b.com", subject: "s", text: "t" });

    expect(result).toBe("not-configured");
    // And it really did not try - no request leaves the process.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still does not throw, so a booking is never lost to a mail server", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "velto@example.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    // The rule this file must not break: a failed email never fails the
    // operation that triggered it.
    await expect(sendEmail({ to: "a@b.com", subject: "s", text: "t" })).resolves.toBe("failed");
  });

  it("reports a provider rejection as a failure, not a send", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "velto@example.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("no", { status: 422 }) as never
    );

    expect(await sendEmail({ to: "a@b.com", subject: "s", text: "t" })).toBe("failed");
  });

  it("reports a send when the provider accepts it", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "velto@example.com";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "1" }), { status: 200 }) as never
    );

    expect(await sendEmail({ to: "a@b.com", subject: "s", text: "t" })).toBe("sent");
  });
});
