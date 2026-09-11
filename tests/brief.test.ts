import { describe, expect, it } from "vitest";
import {
  EMPTY_BRIEF,
  applyExplicit,
  isEmptyBrief,
  parseBrief,
  parseBudget,
  parseDates,
  rankAssets,
  scoreAsset,
  type Brief,
  type ScorableAsset,
} from "@/lib/brief";

/**
 * The brief is the product's answer to "why not just phone the owner". These
 * tests are mostly about the two promises it makes: it never invents a fact,
 * and it says out loud what it does not know.
 */

const CITIES = ["באר שבע", "תל אביב-יפו", "ירושלים"];
const TODAY = new Date(Date.UTC(2026, 8, 11)); // 11/09/2026

function brief(overrides: Partial<Brief> = {}): Brief {
  return { ...EMPTY_BRIEF, ...overrides };
}

function asset(overrides: Partial<ScorableAsset> = {}): ScorableAsset {
  return {
    id: "a1",
    city: "באר שבע",
    assetType: "BILLBOARD",
    isDigital: false,
    locationTags: [],
    widthCm: 900,
    heightCm: 300,
    verificationStatus: "VERIFIED",
    hasImage: true,
    availability: "AVAILABLE",
    priceEstimate: 10000,
    nextAvailable: null,
    ...overrides,
  };
}

describe("reading a budget out of Hebrew", () => {
  it("understands the way people actually write one", () => {
    expect(parseBudget("תקציב 30 אלף")).toBe(30000);
    expect(parseBudget("עד ₪25,000")).toBe(25000);
    expect(parseBudget("תקציב של 18000 שקל")).toBe(18000);
  });

  it("returns null rather than guessing", () => {
    // A budget invented from nothing would filter most of the inventory out of
    // the advertiser's own shortlist, silently.
    expect(parseBudget("קמפיין בבאר שבע בנובמבר")).toBeNull();
    expect(parseBudget("")).toBeNull();
  });
});

describe("reading dates out of Hebrew", () => {
  it("turns a month name into that whole month", () => {
    expect(parseDates("קמפיין בנובמבר", TODAY)).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    });
  });

  it("moves a month that has already passed to next year", () => {
    // Nobody briefs a campaign for a month that ended.
    expect(parseDates("קמפיין במרץ", TODAY).startDate).toBe("2027-03-01");
  });

  it("reads an explicit range", () => {
    expect(parseDates("מ-1.11.2026 עד 14.11.2026", TODAY)).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-14",
    });
  });

  it("leaves dates alone when the text has none", () => {
    expect(parseDates("שלטים בבאר שבע", TODAY)).toEqual({ startDate: null, endDate: null });
  });
});

describe("parsing a whole brief", () => {
  it("pulls city, dates, budget and surroundings out of one sentence", () => {
    const result = parseBrief(
      "קמפיין בבאר שבע בנובמבר, תקציב 30 אלף, ליד הקניון והאוניברסיטה",
      { knownCities: CITIES, today: TODAY }
    );
    expect(result.cities).toEqual(["באר שבע"]);
    expect(result.budget).toBe(30000);
    expect(result.startDate).toBe("2026-11-01");
    expect(result.locationTags).toContain("MALL");
    expect(result.locationTags).toContain("EDUCATION");
  });

  it("never invents a city we have no inventory in", () => {
    // knownCities comes from the database. A city that is not in it cannot
    // enter a brief, however confidently it was typed.
    const result = parseBrief("קמפיין באילת", { knownCities: CITIES, today: TODAY });
    expect(result.cities).toEqual([]);
  });
});

describe("what the form says wins", () => {
  it("overrides the parsed text, so a correction sticks", () => {
    const parsed = brief({ cities: ["באר שבע"], budget: 30000 });
    const merged = applyExplicit(parsed, { cities: ["ירושלים"], budget: 5000 });
    expect(merged.cities).toEqual(["ירושלים"]);
    expect(merged.budget).toBe(5000);
  });

  it("leaves parsed values alone where the form said nothing", () => {
    const parsed = brief({ cities: ["באר שבע"], startDate: "2026-11-01", endDate: "2026-11-30" });
    const merged = applyExplicit(parsed, { cities: [], startDate: null, endDate: null });
    expect(merged.cities).toEqual(["באר שבע"]);
    expect(merged.startDate).toBe("2026-11-01");
  });
});

describe("scoring", () => {
  it("puts availability above everything else", () => {
    const free = scoreAsset(asset({ availability: "AVAILABLE" }), brief());
    const partial = scoreAsset(asset({ availability: "PARTIAL" }), brief());
    const taken = scoreAsset(asset({ availability: "OCCUPIED", nextAvailable: "2026-12-01" }), brief());
    expect(free.score).toBeGreaterThan(partial.score);
    expect(partial.score).toBeGreaterThan(taken.score);
  });

  it("keeps a booked asset on the list when it is about to free up", () => {
    // The one thing an advertiser cannot find out anywhere else.
    const match = scoreAsset(
      asset({ availability: "OCCUPIED", nextAvailable: "2026-12-01" }),
      brief()
    );
    expect(match.score).toBeGreaterThan(0);
    expect(match.reasons).toContain("brief.reason.freesUp");
  });

  it("drops a booked asset with no opening at all", () => {
    const match = scoreAsset(asset({ availability: "OCCUPIED", nextAvailable: null }), brief());
    expect(match.reasons).not.toContain("brief.reason.freesUp");
  });

  it("does not assume an unpriced asset is affordable, and says so", () => {
    const match = scoreAsset(asset({ priceEstimate: null }), brief({ budget: 5000 }));
    expect(match.gaps).toContain("brief.gap.noPrice");
    expect(match.reasons).not.toContain("brief.reason.withinBudget");
  });

  it("keeps an over-budget asset but ranks it below one that fits", () => {
    const fits = scoreAsset(asset({ id: "fits", priceEstimate: 4000 }), brief({ budget: 5000 }));
    const over = scoreAsset(asset({ id: "over", priceEstimate: 90000 }), brief({ budget: 5000 }));
    expect(fits.score).toBeGreaterThan(over.score);
    expect(over.gaps).toContain("brief.gap.overBudget");
  });

  it("names every missing field rather than hiding it", () => {
    const match = scoreAsset(
      asset({ priceEstimate: null, hasImage: false, widthCm: null, heightCm: null }),
      brief()
    );
    expect(match.gaps).toEqual(
      expect.arrayContaining(["brief.gap.noPrice", "brief.gap.noImage", "brief.gap.noSize"])
    );
  });

  it("counts owner-declared surroundings, but for less than a hard fact", () => {
    const tagged = scoreAsset(
      asset({ locationTags: ["MALL"] }),
      brief({ locationTags: ["MALL"] })
    );
    const untagged = scoreAsset(asset(), brief({ locationTags: ["MALL"] }));
    expect(tagged.score).toBeGreaterThan(untagged.score);
    expect(untagged.gaps).toContain("brief.gap.noTags");

    // A tag match must never outweigh being free for the requested dates.
    const taggedButBooked = scoreAsset(
      asset({ locationTags: ["MALL", "CITY_CENTER", "HIGHWAY"], availability: "OCCUPIED", nextAvailable: "2026-12-01" }),
      brief({ locationTags: ["MALL", "CITY_CENTER", "HIGHWAY"] })
    );
    const plainAndFree = scoreAsset(
      asset({ availability: "AVAILABLE" }),
      brief({ locationTags: ["MALL", "CITY_CENTER", "HIGHWAY"] })
    );
    expect(plainAndFree.score).toBeGreaterThan(taggedButBooked.score);
  });

  it("invents no audience figure - the score has no such input", () => {
    // Two assets identical in every column we hold score identically. There is
    // no hidden reach or traffic term that could separate them, because VELTO
    // has no such data and must not pretend otherwise.
    const a = scoreAsset(asset({ id: "a" }), brief({ cities: ["באר שבע"] }));
    const b = scoreAsset(asset({ id: "b" }), brief({ cities: ["באר שבע"] }));
    expect(a.score).toBe(b.score);
  });
});

describe("ranking", () => {
  it("orders best first and stays stable on ties", () => {
    const ranked = rankAssets(
      [
        asset({ id: "b-tie" }),
        asset({ id: "a-tie" }),
        asset({ id: "weak", availability: "PARTIAL", verificationStatus: "PENDING" }),
      ],
      brief()
    );
    expect(ranked[2].assetId).toBe("weak");
    expect([ranked[0].assetId, ranked[1].assetId]).toEqual(["a-tie", "b-tie"]);
  });
});

describe("an empty brief", () => {
  it("is recognised, so the page can ask instead of guessing", () => {
    expect(isEmptyBrief(EMPTY_BRIEF)).toBe(true);
    expect(isEmptyBrief(brief({ cities: ["באר שבע"] }))).toBe(false);
    expect(isEmptyBrief(brief({ budget: 1000 }))).toBe(false);
  });
});
