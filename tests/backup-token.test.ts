import { describe, expect, it } from "vitest";
import { MIN_TOKEN_LENGTH, bearerToken, tokenAuthConfigured, tokenMatches } from "@/lib/backup-token";

/**
 * The comparison that stands between a scheduled job and every user's personal
 * data. Each case here is a way the door could be left open by accident.
 */

const GOOD = "a".repeat(MIN_TOKEN_LENGTH);

describe("comparing a presented token", () => {
  it("accepts the configured token", () => {
    expect(tokenMatches(GOOD, GOOD)).toBe(true);
  });

  it("refuses a different token of the same length", () => {
    expect(tokenMatches("b".repeat(MIN_TOKEN_LENGTH), GOOD)).toBe(false);
  });

  it("refuses a token that differs only in its last character", () => {
    expect(tokenMatches(GOOD.slice(0, -1) + "b", GOOD)).toBe(false);
  });

  it("refuses a prefix of the configured token", () => {
    // Lengths differ, which is exactly the case timingSafeEqual throws on when
    // it is handed raw strings. Hashing first is what makes this a plain false.
    expect(tokenMatches(GOOD.slice(0, 10), GOOD)).toBe(false);
  });

  it("refuses when nothing is configured", () => {
    // The important one: an unset environment variable must not mean "open".
    expect(tokenMatches(GOOD, undefined)).toBe(false);
    expect(tokenMatches(GOOD, null)).toBe(false);
    expect(tokenMatches(GOOD, "")).toBe(false);
  });

  it("refuses a configured token that is too short, even when it matches", () => {
    const short = "short-token";
    expect(tokenMatches(short, short)).toBe(false);
  });

  it("refuses when nothing is presented", () => {
    expect(tokenMatches(null, GOOD)).toBe(false);
    expect(tokenMatches("", GOOD)).toBe(false);
  });

  it("refuses two empty strings", () => {
    expect(tokenMatches("", "")).toBe(false);
  });
});

describe("reading the Authorization header", () => {
  it("takes the token out of a bearer header", () => {
    expect(bearerToken(`Bearer ${GOOD}`)).toBe(GOOD);
  });

  it("does not care how the scheme is capitalised", () => {
    expect(bearerToken(`bearer ${GOOD}`)).toBe(GOOD);
    expect(bearerToken(`BEARER ${GOOD}`)).toBe(GOOD);
  });

  it("tolerates extra spacing around the header", () => {
    expect(bearerToken(`  Bearer   ${GOOD}  `)).toBe(GOOD);
  });

  it("refuses a bare token with no scheme", () => {
    // Usually a misconfigured client rather than a caller worth serving, and
    // accepting it would widen what counts as a credential.
    expect(bearerToken(GOOD)).toBeNull();
  });

  it("refuses another scheme", () => {
    expect(bearerToken(`Basic ${GOOD}`)).toBeNull();
  });

  it("refuses an absent or empty header", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
  });
});

describe("whether token auth is available", () => {
  it("is off without a token and on with a long enough one", () => {
    expect(tokenAuthConfigured(undefined)).toBe(false);
    expect(tokenAuthConfigured("")).toBe(false);
    expect(tokenAuthConfigured("too-short")).toBe(false);
    expect(tokenAuthConfigured(GOOD)).toBe(true);
  });
});
