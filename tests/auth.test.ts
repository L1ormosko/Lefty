import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, makeUser, prisma, TEST_TAG } from "./factories";
import {
  createPasswordResetToken,
  hashPassword,
  hashToken,
  resetPassword,
  verifyPassword,
} from "@/server/auth";
import { resetRateLimit, rateLimit } from "@/server/rate-limit";
import { registerSchema, loginSchema, inquirySchema } from "@/lib/validation";
import { ValidationError } from "@/server/errors";

beforeEach(() => resetRateLimit());

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("password handling", () => {
  it("stores a bcrypt hash, never the password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct");
    expect(hash.startsWith("$2")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("still runs a comparison for an unknown user, and returns false", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  });
});

describe("session tokens", () => {
  it("stores only the hash of the token", async () => {
    const user = await makeUser();
    const token = "a-raw-session-token";
    const session = await prisma.session.create({
      data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 1000) },
    });
    expect(session.tokenHash).not.toBe(token);
    expect(session.tokenHash).toHaveLength(64);
    await prisma.session.deleteMany({ where: { userId: user.id } });
  });

  it("hashes deterministically so lookup works", () => {
    expect(hashToken("x")).toBe(hashToken("x"));
    expect(hashToken("x")).not.toBe(hashToken("y"));
  });
});

describe("login rate limiting", () => {
  it("blocks after the configured number of attempts", () => {
    const key = `${TEST_TAG}:login`;
    for (let i = 0; i < 5; i++) expect(rateLimit(key, 5, 60_000).ok).toBe(true);
    expect(rateLimit(key, 5, 60_000).ok).toBe(false);
  });

  it("keeps separate buckets per key", () => {
    expect(rateLimit(`${TEST_TAG}:a`, 1, 60_000).ok).toBe(true);
    expect(rateLimit(`${TEST_TAG}:a`, 1, 60_000).ok).toBe(false);
    expect(rateLimit(`${TEST_TAG}:b`, 1, 60_000).ok).toBe(true);
  });
});

describe("input validation", () => {
  it("rejects a short password and a malformed email", () => {
    const result = registerSchema.safeParse({
      name: "בדיקה",
      email: "not-an-email",
      password: "short",
      role: "ADVERTISER",
    });
    expect(result.success).toBe(false);
  });

  it("normalises the email to lower case", () => {
    const result = loginSchema.parse({ email: "  UPPER@Example.COM ", password: "x" });
    expect(result.email).toBe("upper@example.com");
  });

  it("refuses an inquiry whose end date precedes its start date", () => {
    const result = inquirySchema.safeParse({
      assetId: "a",
      startDate: "2027-01-10",
      endDate: "2027-01-01",
      campaignName: "קמפיין",
      contactName: "שם",
      contactEmail: "a@b.com",
    });
    expect(result.success).toBe(false);
  });

  it("refuses registration without accepting the terms", () => {
    const withoutTerms = registerSchema.safeParse({
      name: "בדיקה",
      email: "test@example.com",
      password: "a-real-password",
      role: "ADVERTISER",
    });
    expect(withoutTerms.success).toBe(false);

    const withTerms = registerSchema.safeParse({
      name: "בדיקה",
      email: "test@example.com",
      password: "a-real-password",
      role: "ADVERTISER",
      acceptedTerms: "on",
    });
    expect(withTerms.success).toBe(true);
  });
});

describe("password reset", () => {
  it("resets the password and invalidates every existing session", async () => {
    const user = await makeUser();
    await prisma.session.create({
      data: { tokenHash: hashToken("old-session"), userId: user.id, expiresAt: new Date(Date.now() + 10_000) },
    });

    const token = await createPasswordResetToken(user.email);
    expect(token).toBeTruthy();

    await resetPassword(token!, "a-brand-new-password");

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("a-brand-new-password", updated.passwordHash)).toBe(true);
    expect(await verifyPassword("test-password-123", updated.passwordHash)).toBe(false);

    const sessions = await prisma.session.count({ where: { userId: user.id } });
    expect(sessions).toBe(0);
  });

  it("returns null for an unknown email without revealing that", async () => {
    const token = await createPasswordResetToken(`nobody-${Date.now()}@velto-test.local`);
    expect(token).toBeNull();
  });

  it("rejects a token that was already used", async () => {
    const user = await makeUser();
    const token = await createPasswordResetToken(user.email);
    await resetPassword(token!, "first-new-password");
    await expect(resetPassword(token!, "second-new-password")).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an expired token", async () => {
    const user = await makeUser();
    const record = await prisma.passwordResetToken.create({
      data: { tokenHash: hashToken("expired-token"), userId: user.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(resetPassword("expired-token", "whatever-password")).rejects.toBeInstanceOf(ValidationError);
    await prisma.passwordResetToken.delete({ where: { id: record.id } });
  });
});
