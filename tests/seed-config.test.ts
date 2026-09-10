import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, demoSeedEnabled, requireSeedPassword } from "../prisma/seed-config";

/**
 * The seed creates an ADMIN account and runs against whatever DATABASE_URL
 * points at - including production, because the deploy's build command ends
 * with `npm run seed:dev`. The repository is public. So the one thing that
 * must never come back is a built-in password.
 *
 * The environment is passed in explicitly rather than mutated, because
 * process.env is repopulated from .env by Prisma's client on import - which is
 * exactly what made an earlier manual check of the "missing" case pass when it
 * should have failed.
 */
describe("seed credentials", () => {
  it("refuses to run with no password rather than falling back to one", () => {
    expect(() => requireSeedPassword({})).toThrow(/SEED_PASSWORD is not set/);
  });

  it("names the fix in the error, so nobody has to go read the source", () => {
    expect(() => requireSeedPassword({})).toThrow(/randomBytes/);
  });

  it("rejects a password short enough to be typed in by hand", () => {
    expect(() => requireSeedPassword({ SEED_PASSWORD: "1234" })).toThrow(/at least/);
    expect(() => requireSeedPassword({ SEED_PASSWORD: "velto-dev-1234" })).toThrow(/at least/);
    // The boundary itself, so the check cannot be quietly loosened by one.
    expect(() => requireSeedPassword({ SEED_PASSWORD: "x".repeat(MIN_PASSWORD_LENGTH - 1) })).toThrow();
  });

  it("accepts a generated one", () => {
    const generated = "nRZH3socZAF9atGWf1STckWNq4-YoEx0";
    expect(generated.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(requireSeedPassword({ SEED_PASSWORD: generated })).toBe(generated);
  });
});

describe("demo data switch", () => {
  it("is off unless explicitly turned on", () => {
    // Off by default matters: the seed deletes and recreates demo rows on every
    // deploy, so "forgot to set it" must mean no demo data, not some.
    expect(demoSeedEnabled({})).toBe(false);
    expect(demoSeedEnabled({ SEED_DEMO: "0" })).toBe(false);
    expect(demoSeedEnabled({ SEED_DEMO: "true" })).toBe(false);
  });

  it("is on for exactly \"1\"", () => {
    expect(demoSeedEnabled({ SEED_DEMO: "1" })).toBe(true);
  });
});
