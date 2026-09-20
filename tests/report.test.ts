import { describe, expect, it } from "vitest";
import { MAX_MESSAGE, MAX_STACK_LINES, buildReport, redact } from "@/lib/report";

/**
 * An error report leaves the machine, so the question is not whether it is
 * useful but whether it is safe. Every case here is something that has turned
 * up inside a real error message at some point: a connection string, the
 * address of the person the failed lookup was about, a token.
 */

describe("redacting a message before it is sent", () => {
  it("removes the password from a database URL", () => {
    const out = redact("connect ECONNREFUSED postgres://velto:hunter2@db.internal:5432/velto");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[redacted-url]");
  });

  it("removes a labelled credential however it is spelled", () => {
    for (const line of [
      "password: hunter2",
      "API_KEY=AIzaSyVeryRealLookingKey",
      "token = abc123def456",
      "Authorization: xyz",
    ]) {
      const out = redact(line);
      expect(out).toMatch(/\[redacted\]/);
    }
    expect(redact("password: hunter2")).not.toContain("hunter2");
    expect(redact("API_KEY=AIzaSyVeryRealLookingKey")).not.toContain("AIzaSy");
  });

  it("removes a bearer token", () => {
    expect(redact("Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("Bearer [redacted]");
  });

  it("removes the email address a failed lookup named", () => {
    const out = redact("no User found for email dana@negev-media.co.il");
    expect(out).not.toContain("dana@");
    expect(out).toContain("[redacted-email]");
  });

  it("removes a bcrypt hash", () => {
    const hash = "$2b$10$" + "a".repeat(53);
    expect(redact(`compare failed for ${hash}`)).toContain("[redacted-hash]");
    expect(redact(`compare failed for ${hash}`)).not.toContain("a".repeat(53));
  });

  it("leaves an ordinary message alone", () => {
    // Redaction that eats the signal is as useless as none.
    const plain = "Cannot read properties of undefined (reading 'startDate')";
    expect(redact(plain)).toBe(plain);
  });
});

describe("building a report", () => {
  const at = new Date("2026-09-20T12:00:00.000Z");

  it("carries what is needed to find the failure", () => {
    const report = buildReport(new TypeError("boom"), "server action", at, "production");
    expect(report.name).toBe("TypeError");
    expect(report.message).toBe("boom");
    expect(report.context).toBe("server action");
    expect(report.environment).toBe("production");
    expect(report.at).toBe("2026-09-20T12:00:00.000Z");
  });

  it("redacts the message and the stack, not just the message", () => {
    const err = new Error("failed for dana@velto.co.il");
    err.stack = "Error: failed for dana@velto.co.il\n    at login (auth.ts:1:1)";
    const report = buildReport(err, "server action", at);
    expect(report.message).not.toContain("dana@");
    expect(report.stack).not.toContain("dana@");
    expect(report.stack).toContain("auth.ts");
  });

  it("truncates a message long enough to be a log file", () => {
    const report = buildReport(new Error("x".repeat(5000)), "server action", at);
    expect(report.message.length).toBe(MAX_MESSAGE);
  });

  it("keeps only the top of the stack", () => {
    const err = new Error("boom");
    err.stack = ["Error: boom", ...Array.from({ length: 40 }, (_, i) => `    at f${i} (a.ts:${i}:1)`)].join("\n");
    const report = buildReport(err, "server action", at);
    expect(report.stack!.split("\n").length).toBe(MAX_STACK_LINES);
  });

  it("handles something thrown that is not an Error at all", () => {
    // `throw "string"` happens, and a reporter that crashes on it reports
    // nothing at the exact moment it is most needed.
    const report = buildReport("just a string", "server action", at);
    expect(report.message).toBe("just a string");
    expect(report.name).toBe("Error");
  });

  it("redacts the context too", () => {
    const report = buildReport(new Error("boom"), "lookup for dana@velto.co.il", at);
    expect(report.context).not.toContain("dana@");
  });
});
