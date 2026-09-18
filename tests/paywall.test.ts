import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { queryMap, redactForRestricted, withoutSaleableFilters } from "@/server/assets";
import { redactRecommendation, runBrief } from "@/server/brief";
import { EMPTY_BRIEF } from "@/lib/brief";
import { mapQuerySchema, profileSchema, safeExternalUrl } from "@/lib/validation";
import { addDays, todayUtc } from "@/lib/dates";

/**
 * The paywall, on every surface that can leak through it.
 *
 * Three separate holes were found in one audit and they had one shape between
 * them: the map was careful, and everything else that lists inventory was not.
 * The brief handed an anonymous visitor a street address and a priced
 * estimate. Saved assets handed a lapsed advertiser the same. And the map's
 * own filters answered questions the redaction refused to answer directly.
 *
 * So these tests are deliberately about *what reaches the caller*, not about
 * what a component chooses to paint.
 */

let assetId: string;

beforeAll(async () => {
  await cleanup();
  const owner = await makeUser("MEDIA_OWNER");
  const asset = await makeAsset(owner.id, {
    title: "שלט חוצות - דרך חברון 42",
    address: "דרך חברון 42",
    priceMonthly: 4000,
  });
  assetId = asset.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("map redaction", () => {
  it("removes every saleable field and keeps the ones that argue for signing up", async () => {
    const { assets } = await queryMap(mapQuerySchema.parse({}));
    const row = assets.find((a) => a.id === assetId);
    expect(row, "the seeded asset should be on the map").toBeDefined();

    const blurred = redactForRestricted(row!);

    expect(blurred.address).toBe("");
    expect(blurred.priceMonthly).toBeNull();
    expect(blurred.priceWeekly).toBeNull();
    expect(blurred.nextAvailable).toBeNull();
    expect(blurred.imageUrl).toBeNull();
    // The title carried the street name, which is the address by another route.
    // What replaces it is the type of sign - public anyway, and enough to tell
    // ten blurred rows apart, which "באר שבע" ten times over was not.
    expect(blurred.title).not.toContain("חברון");
    expect(blurred.title).toBe("שלט חוצות");
    expect(blurred.restricted).toBe(true);

    // Still useful: a visitor can see there is a billboard in this city.
    expect(blurred.city).toBe(row!.city);
    expect(blurred.assetType).toBe(row!.assetType);
  });

  it("moves the pin to the neighbourhood and keeps it there", () => {
    const first = redactForRestricted({ ...base(), latitude: 31.251893, longitude: 34.791347 });
    const second = redactForRestricted({ ...base(), latitude: 31.251893, longitude: 34.791347 });

    expect(first.latitude).not.toBe(31.251893);
    // Stable rather than noisy: repeated loads cannot be averaged back to the
    // true point, and the sign does not jitter around the map.
    expect(first.latitude).toBe(second.latitude);
    expect(Math.abs(first.latitude - 31.251893)).toBeLessThan(0.01);
  });
});

describe("filters as an oracle", () => {
  /**
   * The subtle half of the leak. Blanking a price in the response is useless if
   * `maxPrice=4000` returns the sign and `maxPrice=3999` does not - that states
   * the price to the shekel in two requests.
   */
  it("strips the filters that would answer a withheld question", () => {
    const asked = mapQuerySchema.parse({
      city: "באר שבע",
      types: "BILLBOARD",
      digitalOnly: "1",
      verifiedOnly: "1",
      q: "חברון",
      minPrice: "3999",
      maxPrice: "4001",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      availability: "AVAILABLE",
    });

    const safe = withoutSaleableFilters(asked);

    expect(safe.minPrice).toBeUndefined();
    expect(safe.maxPrice).toBeUndefined();
    expect(safe.startDate).toBeUndefined();
    expect(safe.endDate).toBeUndefined();
    expect(safe.availability).toBeUndefined();

    // Everything that filters on what a restricted viewer may see anyway stays,
    // or the blurred map would stop being usable at all. Free text stays too -
    // queryMap narrows it to the city rather than dropping the search box.
    expect(safe.q).toBe("חברון");
    expect(safe.city).toBe("באר שבע");
    expect(safe.types).toBe("BILLBOARD");
    expect(safe.digitalOnly).toBe("1");
    expect(safe.verifiedOnly).toBe("1");
    expect(safe.minLat).toBe(asked.minLat);
  });

  it("really does stop the price oracle end to end", async () => {
    const tight = mapQuerySchema.parse({ minPrice: "3999", maxPrice: "4001" });
    const withFilter = await queryMap(tight);
    const asRestricted = await queryMap(tight, { restricted: true });

    // With the filter the asset is singled out by its exact price; for a
    // restricted viewer the same request returns everything, so comparing two
    // price bounds tells them nothing.
    expect(withFilter.assets.some((a) => a.id === assetId)).toBe(true);
    expect(asRestricted.assets.length).toBeGreaterThan(withFilter.assets.length);
  });

  it("narrows free-text search to the city instead of reading the address back", async () => {
    const byStreet = mapQuerySchema.parse({ q: "חברון" });

    // A viewer with access can find the sign by its street.
    const full = await queryMap(byStreet);
    expect(full.assets.some((a) => a.id === assetId)).toBe(true);

    // A restricted viewer searching the same street matches nothing, because
    // only the city is searched - and the city is on the card anyway.
    const blurred = await queryMap(byStreet, { restricted: true });
    expect(blurred.assets.some((a) => a.id === assetId)).toBe(false);

    // The box still works for what it is allowed to see.
    const byCity = await queryMap(mapQuerySchema.parse({ q: "באר שבע" }), { restricted: true });
    expect(byCity.assets.some((a) => a.id === assetId)).toBe(true);
  });
});

describe("the brief", () => {
  it("ranks for a restricted viewer but does not price or place the results", async () => {
    const matches = await runBrief({ ...EMPTY_BRIEF, cities: ["באר שבע"] });
    expect(matches.length).toBeGreaterThan(0);

    const blurred = matches.map(redactRecommendation);
    for (const match of blurred) {
      expect(match.asset.address).toBe("");
      expect(match.asset.priceEstimate).toBeNull();
      expect(match.asset.nextAvailable).toBeNull();
      expect(match.asset.imageUrl).toBeNull();
      expect(match.asset.restricted).toBe(true);
    }

    // The ranking itself survives: which of our sites fits a campaign is a
    // fair sample of the product, and it is not what the subscription sells.
    expect(blurred[0].reasons).toEqual(matches[0].reasons);
    expect(blurred[0].score).toBe(matches[0].score);
  });
});

/** A minimal row, for the redactions that do not need the database. */
function base() {
  return {
    id: "x",
    title: "t",
    city: "באר שבע",
    address: "a",
    assetType: "BILLBOARD",
    isDigital: false,
    latitude: 31.25,
    longitude: 34.79,
    priceMonthly: 1,
    priceWeekly: 1,
    verificationStatus: "VERIFIED",
    isDemo: false,
    imageUrl: null,
    availability: "AVAILABLE" as const,
    nextAvailable: todayUtc().toISOString().slice(0, 10),
  };
}

describe("the map says when it is showing you a subset", () => {
  it("reports the true total even when the page is cut short", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    await Promise.all(
      Array.from({ length: 4 }, () =>
        makeAsset(owner.id, {
          periods: { create: [{ startDate: todayUtc(), endDate: addDays(todayUtc(), 30) }] },
        })
      )
    );

    const result = await queryMap(mapQuerySchema.parse({ limit: "2" }));

    expect(result.assets.length).toBe(2);
    expect(result.total).toBeGreaterThan(2);
    // The honest signal. Without it the map silently shows nine of twenty free
    // signs in a city and looks complete.
    expect(result.truncated).toBe(true);
  });
});

describe("owner-supplied links", () => {
  /**
   * A media owner's company website is rendered as an <a href> on their public
   * asset page. z.string().url() delegates to `new URL()`, which accepts
   * javascript: and data: happily - so without an allow-list this field was
   * stored XSS against every advertiser who opened the listing.
   */
  it("accepts only http and https", () => {
    expect(safeExternalUrl("https://velto.co.il")).toBe("https://velto.co.il/");
    expect(safeExternalUrl("http://example.com/x")).toBe("http://example.com/x");

    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("JavaScript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalUrl("vbscript:msgbox(1)")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl("")).toBeNull();
  });

  it("refuses the same schemes at the schema, not only at render", () => {
    const bad = profileSchema.safeParse({
      name: "בודק",
      companyName: "חברה",
      companyWebsite: "javascript:alert(1)",
    });
    expect(bad.success).toBe(false);

    const good = profileSchema.safeParse({
      name: "בודק",
      companyName: "חברה",
      companyWebsite: "https://velto.co.il",
    });
    expect(good.success).toBe(true);
  });
});
