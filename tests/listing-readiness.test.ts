import { describe, expect, it } from "vitest";
import { listingReadiness, type ReadinessInput } from "@/lib/listing-readiness";

/**
 * A listing can be published with a title, a location and one photo - nothing
 * forces a price or an availability window. So a live listing can tell a buyer
 * nothing about what it costs or when it is free, and the owner has no way to
 * know that is how it looks from the outside. These tests pin what counts.
 */

function asset(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    imageCount: 1,
    priceMonthly: 11000,
    priceWeekly: null,
    futurePeriodCount: 1,
    widthCm: 900,
    heightCm: 300,
    description: "שלט דו־צדדי בציר ראשי",
    locationTags: ["MAIN_ROAD"],
    ...overrides,
  };
}

describe("the three that decide whether a listing is answerable", () => {
  it("calls a listing with a photo, a price and a window ready", () => {
    expect(listingReadiness(asset({ description: null, locationTags: [] })).level).toBe("ready");
  });

  it("is incomplete without a photo, whatever else is filled in", () => {
    expect(listingReadiness(asset({ imageCount: 0 })).level).toBe("incomplete");
  });

  it("is incomplete without a price, even with a photo", () => {
    // The failure this names: a fully photographed, fully described listing
    // that never says what it costs still forces the buyer to pick up a phone,
    // which is the exact thing the product exists to remove.
    const r = listingReadiness(asset({ priceMonthly: null, priceWeekly: null }));
    expect(r.level).toBe("incomplete");
    expect(r.missing).toContain("price");
  });

  it("accepts either published rate as a price", () => {
    expect(listingReadiness(asset({ priceMonthly: null, priceWeekly: 3200 })).level).not.toBe(
      "incomplete"
    );
  });

  it("is incomplete with no future availability window", () => {
    // Availability is derived from declared windows minus approved bookings,
    // so an asset with no window reads as occupied to every buyer.
    expect(listingReadiness(asset({ futurePeriodCount: 0 })).level).toBe("incomplete");
  });
});

describe("strong", () => {
  it("means everything, not a threshold", () => {
    expect(listingReadiness(asset()).level).toBe("strong");
    expect(listingReadiness(asset()).missing).toEqual([]);
  });

  it("drops to ready one field short, rather than inventing a percentage", () => {
    const r = listingReadiness(asset({ locationTags: [] }));
    expect(r.level).toBe("ready");
    expect(r.missing).toEqual(["surroundings"]);
  });
});

describe("what it reports back", () => {
  it("orders what is missing by what it costs the owner", () => {
    const r = listingReadiness({
      imageCount: 0,
      priceMonthly: null,
      priceWeekly: null,
      futurePeriodCount: 0,
      widthCm: null,
      heightCm: null,
      description: null,
      locationTags: [],
    });
    // Photo, price and dates first - the three a buyer shortlists on.
    expect(r.missing.slice(0, 3)).toEqual(["photo", "price", "availability"]);
    expect(r.present).toEqual([]);
  });

  it("treats whitespace as no description", () => {
    expect(listingReadiness(asset({ description: "   " })).missing).toContain("description");
  });

  it("needs both dimensions, not one", () => {
    expect(listingReadiness(asset({ heightCm: null })).missing).toContain("dimensions");
  });

  it("never reports a field as both present and missing", () => {
    const r = listingReadiness(asset({ imageCount: 0, description: null }));
    expect(r.present.filter((item) => r.missing.includes(item))).toEqual([]);
  });
});
