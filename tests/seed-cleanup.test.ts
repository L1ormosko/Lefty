import { describe, expect, it } from "vitest";
import { cleanup, prisma } from "./factories";

/**
 * What the seed deletes before it recreates its own rows.
 *
 * The seed used to find its accounts with `email ENDS WITH '@velto.dev'`.
 * velto.dev is the product's own domain and is not registered yet; the day it
 * is, office@ or support@ belongs to a real person, and the next deploy would
 * have deleted that account and cascaded through their listings, inquiries and
 * bookings.
 *
 * This asserts the rule that replaced it: a row is demo because it is flagged
 * demo, never because of what it is called. The old rule is exercised
 * alongside the new one, so a revert cannot pass quietly.
 */

const TAG = "seed-cleanup-test";

describe("finding the rows the seed owns", () => {
  it("deletes flagged accounts and spares a real person at the same domain", async () => {
    await cleanup();

    const seeded = await prisma.user.create({
      data: {
        email: `owner-${TAG}@velto.dev`,
        passwordHash: "x",
        name: `seeded ${TAG}`,
        role: "MEDIA_OWNER",
        isDemo: true,
      },
    });
    // A real member of staff, at the very domain the old rule matched on.
    const staff = await prisma.user.create({
      data: {
        email: `noa-${TAG}@velto.dev`,
        passwordHash: "x",
        name: `staff ${TAG}`,
        role: "ADMIN",
        isDemo: false,
      },
    });

    // Exactly what prisma/seed.ts runs.
    await prisma.user.deleteMany({ where: { isDemo: true, email: { contains: TAG } } });

    expect(await prisma.user.findUnique({ where: { id: seeded.id } })).toBeNull();
    const survivor = await prisma.user.findUnique({ where: { id: staff.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.email).toContain("@velto.dev");

    // And the rule that was there before would have taken them both.
    const byAddress = await prisma.user.findMany({
      where: { email: { endsWith: "@velto.dev" }, AND: { email: { contains: TAG } } },
      select: { id: true },
    });
    expect(byAddress.map((u) => u.id)).toEqual([staff.id]);

    await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
  });

  it("defaults a newly registered account to not-demo", async () => {
    // The column is what the deletion keys on, so its default is load-bearing:
    // a signup that somehow arrived flagged would be deleted on next deploy.
    const user = await prisma.user.create({
      data: { email: `signup-${TAG}@example.com`, passwordHash: "x", name: `signup ${TAG}` },
    });
    expect(user.isDemo).toBe(false);
    await prisma.user.delete({ where: { id: user.id } });
  });
});
