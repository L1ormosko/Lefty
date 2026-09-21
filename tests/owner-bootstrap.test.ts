import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapOwner, MIN_OWNER_PASSWORD_LENGTH, ownerConfig } from "../prisma/owner";
import { verifyPassword } from "@/server/auth";
import { cleanup, prisma, TEST_TAG } from "./factories";

/**
 * The way back into a platform whose only door is locked.
 *
 * Three facts made an operator unable to reach their own site: the production
 * database accepts no external connections, password reset by email is not
 * configured so the "we sent you a link" message was a dead end, and the only
 * way to appoint an admin is a screen you must already be an admin to open.
 *
 * This is the escape hatch, so it is tested for the two things an escape
 * hatch must never be: closed when it is needed (the account has to survive
 * the demo seed's deletion pass, which runs on the very same deploy) and open
 * when it is not.
 */

const EMAIL = `owner@${TEST_TAG}.local`;
const PASSWORD = "a-real-password-1";

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe("reading the configuration", () => {
  it("is nothing at all when neither variable is set", () => {
    // The normal state of a deployment: silence, not an error.
    expect(ownerConfig({})).toBeNull();
  });

  it("refuses one without the other", () => {
    expect(() => ownerConfig({ VELTO_OWNER_EMAIL: EMAIL })).toThrow(/together/);
    expect(() => ownerConfig({ VELTO_OWNER_PASSWORD: PASSWORD })).toThrow(/together/);
  });

  it("refuses a password short enough to guess", () => {
    expect(() =>
      ownerConfig({ VELTO_OWNER_EMAIL: EMAIL, VELTO_OWNER_PASSWORD: "short" })
    ).toThrow(new RegExp(`${MIN_OWNER_PASSWORD_LENGTH}`));
  });

  it("refuses something that is not an email", () => {
    expect(() =>
      ownerConfig({ VELTO_OWNER_EMAIL: "not-an-email", VELTO_OWNER_PASSWORD: PASSWORD })
    ).toThrow(/not an email/);
  });

  it("normalizes the address the way login does", () => {
    // login() lowercases and trims before looking the user up; a bootstrap
    // that stored "Owner@..." would create an account nobody could sign into.
    const config = ownerConfig({
      VELTO_OWNER_EMAIL: `  OWNER@${TEST_TAG}.LOCAL `,
      VELTO_OWNER_PASSWORD: PASSWORD,
    });
    expect(config).toEqual({ email: EMAIL, password: PASSWORD });
  });
});

describe("creating the account", () => {
  it("creates an admin whose password actually works", async () => {
    const result = await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    expect(result.created).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.role).toBe("ADMIN");
    expect(user.isActive).toBe(true);
    // The point of the whole exercise - not that a row exists, but that the
    // password in the host's configuration opens it.
    expect(await verifyPassword(PASSWORD, user.passwordHash)).toBe(true);
  });

  it("grants access, not only the admin screens", async () => {
    // An admin with no subscription can open /admin and still hits the
    // paywall on a listing page. That half-state is what this is fixing.
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(subscription.paidThrough!.getTime()).toBeGreaterThan(Date.now());
  });

  it("survives the demo seed's deletion pass", async () => {
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });

    // Exactly what prisma/seed.ts runs on every deploy, in the same build as
    // the bootstrap. An account flagged isDemo would be deleted minutes after
    // being created, and the operator would be locked out again by their own
    // deploy.
    await prisma.user.deleteMany({ where: { isDemo: true } });

    expect(await prisma.user.findUnique({ where: { email: EMAIL } })).not.toBeNull();
  });

  it("records that the door was used", async () => {
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });

    const entry = await prisma.auditLog.findFirst({
      where: { action: "USER_ROLE_CHANGED", targetId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.actorId).toBeNull();
    expect(entry!.summary).toContain("bootstrap");
    // A credential must never reach the log.
    expect(entry!.summary).not.toContain(PASSWORD);
  });
});

describe("running it again", () => {
  it("promotes the account the operator already registered", async () => {
    // The ordinary case: they signed up through the site like anyone else,
    // as an advertiser, and their trial has since run out.
    const existing = await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: "not-a-usable-hash",
        name: `${TEST_TAG} existing`,
        role: "ADVERTISER",
      },
    });

    const result = await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    expect(result.created).toBe(false);
    expect(result.promoted).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(after.id).toBe(existing.id);
    expect(after.role).toBe("ADMIN");
    // The profile is left alone: this is a key, not a profile editor.
    expect(after.name).toBe(`${TEST_TAG} existing`);
  });

  it("re-asserts a forgotten password instead of failing", async () => {
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    const second = "a-different-password-2";
    await bootstrapOwner(prisma, { email: EMAIL, password: second });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    // Re-applying on every deploy is the recovery property, not a bug: it is
    // how somebody who forgot the password gets back in.
    expect(await verifyPassword(second, user.passwordHash)).toBe(true);
    expect(await verifyPassword(PASSWORD, user.passwordHash)).toBe(false);
  });

  it("leaves one account and one subscription, however many deploys run", async () => {
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });

    expect(await prisma.user.count({ where: { email: EMAIL } })).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(1);
  });

  it("reactivates an account that was switched off", async () => {
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    // login() refuses an inactive user, so a bootstrap that left the flag
    // alone would hand back a password that still does not work.
    await bootstrapOwner(prisma, { email: EMAIL, password: PASSWORD });
    const after = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(after.isActive).toBe(true);
  });
});
