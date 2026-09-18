import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { viewerAccess } from "@/server/subscription";
import { redactForRestricted, queryMapAssets } from "@/server/assets";
import { trialEnd } from "@/lib/subscription";
import { mapQuerySchema } from "@/lib/validation";

/**
 * Access against a real database.
 *
 * The pure rules are in tests/subscription.test.ts. What matters here is that
 * the redaction is real - that a restricted viewer's rows genuinely do not
 * carry the price or the exact position, because those rows are serialised
 * straight onto the wire.
 */

let ownerId: string;

beforeEach(async () => {
  await cleanup();
  ownerId = (await makeUser("MEDIA_OWNER")).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

describe("what a viewer is allowed", () => {
  it("gives a brand-new account a live trial", async () => {
    const user = await makeUser("ADVERTISER");
    await prisma.subscription.create({ data: { userId: user.id, trialEndsAt: trialEnd() } });
    const a = await viewerAccess({ id: user.id, role: user.role });
    expect(a.state).toBe("trial");
    expect(a.full).toBe(true);
  });

  it("restricts an account whose trial has passed", async () => {
    const user = await makeUser("ADVERTISER");
    await prisma.subscription.create({ data: { userId: user.id, trialEndsAt: days(-1) } });
    const a = await viewerAccess({ id: user.id, role: user.role });
    expect(a.full).toBe(false);
  });

  it("restricts an anonymous visitor", async () => {
    expect((await viewerAccess(null)).full).toBe(false);
  });

  it("never restricts an admin, who has to verify the addresses", async () => {
    const admin = await makeUser("ADMIN");
    const a = await viewerAccess({ id: admin.id, role: admin.role });
    expect(a.full).toBe(true);
    expect(a.admin).toBe(true);
  });
});

describe("redaction is real, not cosmetic", () => {
  it("strips everything VELTO sells from a listing", async () => {
    // By id, not [0]: the database also holds the seeded demo inventory, and
    // taking the first row tested whichever listing happened to sort highest.
    const asset = await makeAsset(ownerId, {
      status: "ACTIVE",
      priceMonthly: 9000,
      address: "רחוב סודי 4",
    });
    const rows = await queryMapAssets(mapQuerySchema.parse({ limit: 500 }));
    const row = rows.find((r) => r.id === asset.id)!;
    expect(row, "the test asset was not returned").toBeDefined();
    expect(row.priceMonthly).toBe(9000);

    const hidden = redactForRestricted(row);
    expect(hidden.priceMonthly).toBeNull();
    expect(hidden.priceWeekly).toBeNull();
    expect(hidden.address).toBe("");
    expect(hidden.nextAvailable).toBeNull();
    expect(hidden.restricted).toBe(true);
  });

  it("moves the pin off the exact spot but keeps it in the area", async () => {
    const asset = await makeAsset(ownerId, {
      status: "ACTIVE",
      latitude: 31.25181,
      longitude: 34.79133,
    });
    const rows = await queryMapAssets(mapQuerySchema.parse({ limit: 500 }));
    const row = rows.find((r) => r.id === asset.id)!;
    const hidden = redactForRestricted(row);

    expect(hidden.latitude).not.toBe(row.latitude);
    const metres = Math.abs(hidden.latitude - row.latitude) * 111_320;
    expect(metres).toBeLessThan(500);
  });

  it("leaves no street name behind in the title", async () => {
    // Titles routinely carry the address ("שלט חוצות - דרך חברון"), so
    // blanking the address field alone would not have hidden the location.
    const asset = await makeAsset(ownerId, {
      status: "ACTIVE",
      title: `velto-test שלט חוצות — דרך חברון 12`,
      address: "דרך חברון 12",
      city: "באר שבע",
    });
    const rows = await queryMapAssets(mapQuerySchema.parse({ limit: 500 }));
    const row = rows.find((r) => r.id === asset.id)!;
    const hidden = redactForRestricted(row);
    expect(hidden.title).not.toContain("חברון");
    // What replaces it is the type of sign rather than the city. The city made
    // a shortlist of ten read as ten identical cards called "באר שבע" -
    // redacted, and useless as a ranking. The type is public on the card
    // anyway and tells the rows apart.
    expect(hidden.title).toBe("שלט חוצות");
    expect(hidden.city).toBe("באר שבע");
  });
});
