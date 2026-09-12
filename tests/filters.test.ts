import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  describeFilters,
  suggestRelaxation,
  type Filters,
} from "@/components/map/filters";

function withFilters(overrides: Partial<Filters> = {}): Filters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe("describing what is filtered", () => {
  it("gives every selected value its own chip", () => {
    // The bug this replaces: the counter collapsed the whole `types` array to
    // one, so three selected asset types reported as a single active filter.
    const chips = describeFilters(withFilters({ types: ["BILLBOARD", "WALL", "TOTEM"] }));
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.id)).toEqual(["type:BILLBOARD", "type:WALL", "type:TOTEM"]);
  });

  it("counts what the chips count, so the badge cannot disagree with the row", () => {
    const filters = withFilters({
      types: ["BILLBOARD", "WALL"],
      availability: ["AVAILABLE"],
      city: "באר שבע",
    });
    expect(activeFilterCount(filters)).toBe(describeFilters(filters).length);
    expect(activeFilterCount(filters)).toBe(4);
  });

  it("is empty when nothing is applied", () => {
    expect(describeFilters(EMPTY_FILTERS)).toEqual([]);
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });

  it("marks user-typed values as literal so they are not looked up as keys", () => {
    const chips = describeFilters(withFilters({ city: "באר שבע", q: "רגר" }));
    expect(chips.every((c) => c.literal)).toBe(true);
  });

  it("treats a price or date range as one chip, not two", () => {
    const price = describeFilters(withFilters({ minPrice: "1000", maxPrice: "9000" }));
    expect(price).toHaveLength(1);
    const dates = describeFilters(withFilters({ startDate: "2026-11-01", endDate: "2026-11-30" }));
    expect(dates).toHaveLength(1);
  });

  it("ignores a half-set date range, which filters nothing", () => {
    expect(describeFilters(withFilters({ startDate: "2026-11-01" }))).toEqual([]);
  });
});

describe("removing one chip", () => {
  it("clears exactly that value and leaves its neighbours alone", () => {
    const filters = withFilters({ types: ["BILLBOARD", "WALL", "TOTEM"] });
    const wall = describeFilters(filters).find((c) => c.id === "type:WALL")!;
    expect(wall.clear.types).toEqual(["BILLBOARD", "TOTEM"]);
  });

  it("clears both ends of a range together", () => {
    const filters = withFilters({ minPrice: "1000", maxPrice: "9000" });
    const price = describeFilters(filters)[0];
    expect(price.clear).toEqual({ minPrice: "", maxPrice: "" });
  });

  it("produces a patch that actually empties the filter when applied", () => {
    const filters = withFilters({ digitalOnly: true, verifiedOnly: true });
    const digital = describeFilters(filters).find((c) => c.id === "digital")!;
    const after = { ...filters, ...digital.clear };
    expect(describeFilters(after).map((c) => c.id)).toEqual(["verified"]);
  });
});

describe("what to offer when nothing matched", () => {
  it("offers the tightest filter first", () => {
    // A date window rules out almost everything; a city rules out the least
    // and is usually the thing the advertiser actually meant.
    const filters = withFilters({
      city: "באר שבע",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      verifiedOnly: true,
    });
    expect(suggestRelaxation(filters)?.id).toBe("dates");
  });

  it("falls through the ranking as filters are removed", () => {
    expect(suggestRelaxation(withFilters({ verifiedOnly: true, city: "חיפה" }))?.id).toBe(
      "verified"
    );
    expect(suggestRelaxation(withFilters({ city: "חיפה", types: ["WALL"] }))?.id).toBe("type:WALL");
    expect(suggestRelaxation(withFilters({ city: "חיפה" }))?.id).toBe("city");
  });

  it("suggests nothing when no filter is applied", () => {
    // Then the honest answer is "there is nothing here", not "loosen something".
    expect(suggestRelaxation(EMPTY_FILTERS)).toBeNull();
  });
});
