import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, verifyTotp } from "@/lib/totp";
import { ValidationError } from "@/server/core";
import { assertPasswordMeetsPolicy, hashPassword, verifyPassword } from "@/server/auth";
import { decryptSecret, encryptSecret, isEncryptionConfigured, EncryptionKeyError } from "@/server/auth/secret-box";
import { hashToken, issueToken, tenantIdFromToken } from "@/server/auth/tokens";
import { hitRateLimit } from "@/server/auth/rate-limiter";
import { useTestEncryptionKey } from "./auth-helpers";

describe("TOTP (RFC 6238 / RFC 4226)", () => {
  // RFC 6238 appendix B: the ASCII secret "12345678901234567890" with HMAC-SHA1, 8 digits.
  const rfcSecret = Buffer.from("12345678901234567890");

  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    for (const [seconds, expected] of vectors) {
      expect(hotp(rfcSecret, Math.floor(seconds / 30), 8)).toBe(expected);
    }
  });

  it("matches the RFC 4226 HOTP test vectors", () => {
    expect([0, 1, 2].map((counter) => hotp(rfcSecret, counter))).toEqual(["755224", "287082", "359152"]);
  });

  it("accepts the previous, current and next step and returns the matched step", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    for (const drift of [-1, 0, 1]) {
      expect(verifyTotp(rfcSecret, hotp(rfcSecret, step + drift), now)).toBe(step + drift);
    }
  });

  it("rejects codes two steps away, malformed codes and wrong codes", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(rfcSecret, hotp(rfcSecret, step + 2), now)).toBeNull();
    expect(verifyTotp(rfcSecret, "12345", now)).toBeNull();
    expect(verifyTotp(rfcSecret, "abcdef", now)).toBeNull();
  });

  it("round-trips base32", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 8, 9]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });
});

describe("password policy and hashing", () => {
  it("requires at least 12 characters", () => {
    expect(() => assertPasswordMeetsPolicy("short-pw-1")).toThrow(ValidationError);
    expect(() => assertPasswordMeetsPolicy("exactly12chr")).not.toThrow();
  });

  it("refuses passwords bcrypt would silently truncate and passwords equal to the email", () => {
    expect(() => assertPasswordMeetsPolicy("x".repeat(73))).toThrow(ValidationError);
    expect(() => assertPasswordMeetsPolicy("person@example.test", "Person@Example.test")).toThrow(ValidationError);
  });

  it("hashes with bcrypt cost 12 and verifies", async () => {
    const hash = await hashPassword("a long enough password");
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword("a long enough password", hash)).toBe(true);
    expect(await verifyPassword("another password", hash)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

describe("secret box (AES-256-GCM)", () => {
  const originalKey = process.env.LEADRO_ENCRYPTION_KEY;
  beforeEach(() => useTestEncryptionKey());
  afterEach(() => {
    if (originalKey === undefined) delete process.env.LEADRO_ENCRYPTION_KEY;
    else process.env.LEADRO_ENCRYPTION_KEY = originalKey;
  });

  it("round-trips, never stores plaintext and uses a fresh IV each time", () => {
    const secret = Buffer.from("totp-seed-bytes-1234");
    const first = encryptSecret(secret);
    expect(first).not.toContain(secret.toString("base64"));
    expect(first).not.toBe(encryptSecret(secret));
    expect(decryptSecret(first)).toEqual(secret);
  });

  it("detects tampering", () => {
    const [version, iv, tag, ciphertext] = encryptSecret(Buffer.from("seed")).split(":");
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] ^= 1;
    expect(() => decryptSecret([version, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("refuses to work without a valid 32-byte key", () => {
    delete process.env.LEADRO_ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
    expect(() => encryptSecret(Buffer.from("seed"))).toThrow(EncryptionKeyError);
    process.env.LEADRO_ENCRYPTION_KEY = Buffer.from("too short").toString("base64");
    expect(() => encryptSecret(Buffer.from("seed"))).toThrow(EncryptionKeyError);
  });
});

describe("tokens", () => {
  it("embeds the tenant id and stores only a hash", () => {
    const { token, tokenHash } = issueToken("tenant123");
    expect(tenantIdFromToken(token)).toBe("tenant123");
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).not.toContain(token.split(".")[1]);
    expect(tenantIdFromToken("garbage")).toBeNull();
    expect(tenantIdFromToken(".x")).toBeNull();
  });
});

describe("rate limiter", () => {
  it("allows up to the limit within a window and resets after it", () => {
    const rule = { limit: 2, windowMs: 1000 };
    const key = `unit:${Math.random()}`;
    expect(hitRateLimit(key, rule, 0).allowed).toBe(true);
    expect(hitRateLimit(key, rule, 10).allowed).toBe(true);
    expect(hitRateLimit(key, rule, 20).allowed).toBe(false);
    expect(hitRateLimit(key, rule, 1001).allowed).toBe(true);
  });
});
