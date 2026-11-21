import { describe, it, expect } from "vitest";
import { REDACTED, isSensitiveKey, redactSensitive } from "@/lib/redact";

describe("isSensitiveKey", () => {
  it.each(["password", "passwordHash", "password_hash", "MFA_SECRET", "mfaSecret", "sessionToken", "Authorization", "cookie", "apiKey", "api-key"])(
    "treats %s as sensitive",
    (key) => expect(isSensitiveKey(key)).toBe(true),
  );

  it.each(["email", "name", "status", "tenantId"])("leaves %s alone", (key) => expect(isSensitiveKey(key)).toBe(false));
});

describe("redactSensitive", () => {
  it("masks sensitive keys at any depth, including inside arrays", () => {
    const result = redactSensitive({
      email: "a@b.test",
      passwordHash: "$argon2$abc",
      nested: { mfaSecret: "JBSWY3DP", list: [{ refreshToken: "t1", keep: 1 }] },
    });
    expect(result).toEqual({
      email: "a@b.test",
      passwordHash: REDACTED,
      nested: { mfaSecret: REDACTED, list: [{ refreshToken: REDACTED, keep: 1 }] },
    });
  });

  it("does not mutate its input", () => {
    const input = { password: "hunter2", other: { token: "x" } };
    redactSensitive(input);
    expect(input).toEqual({ password: "hunter2", other: { token: "x" } });
  });

  it("makes values JSON-safe (Date, BigInt, undefined)", () => {
    const result = redactSensitive({ at: new Date("2026-01-02T03:04:05.000Z"), cents: 12n, gone: undefined });
    expect(result).toEqual({ at: "2026-01-02T03:04:05.000Z", cents: "12" });
  });

  it("truncates instead of recursing forever on cyclic data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => JSON.stringify(redactSensitive(cyclic))).not.toThrow();
  });
});
