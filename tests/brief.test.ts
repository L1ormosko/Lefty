import { describe, expect, it } from "vitest";
import {
  EMPTY_BRIEF,
  applyExplicit,
  isEmptyBrief,
  parseBrief,
  parseBudget,
  parseDates,
  mergeTopMatches,
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

/**
 * Ranking an inventory too large to score in one query.
 *
 * runBrief used to read 500 rows and rank what came back, so above 500 active
 * listings the best match in the country could sit at row 501 and never be
 * looked at. It now pages, scores every page and merges. These tests pin the
 * property that makes the paging sound: because scoreAsset is absolute, the
 * merged answer is the answer.
 */
describe("merging ranked pages", () => {
  const scorableRun = (ids: string[], availability: ScorableAsset["availability"]) =>
    ids.map((id) => asset({ id, availability }));

  it("gives the same shortlist as ranking everything at once", () => {
    // A hundred assets split across four pages, with the strongest candidates
    // scattered so no single page holds them all.
    const all: ScorableAsset[] = [];
    for (let i = 0; i < 100; i++) {
      all.push(
        asset({
          id: `a${String(i).padStart(3, "0")}`,
          // Every seventh one is the good one.
          availability: i % 7 === 0 ? "AVAILABLE" : "OCCUPIED",
          nextAvailable: i % 7 === 0 ? null : "2026-12-01",
        })
      );
    }

    const atOnce = rankAssets(all, brief())
      .filter((m) => m.score > 0)
      .slice(0, 10);

    let merged: ReturnType<typeof rankAssets> = [];
    for (let start = 0; start < all.length; start += 25) {
      const page = rankAssets(all.slice(start, start + 25), brief()).filter((m) => m.score > 0);
      merged = mergeTopMatches(merged, page, 10);
    }

    expect(merged.map((m) => m.assetId)).toEqual(atOnce.map((m) => m.assetId));
    expect(merged.map((m) => m.score)).toEqual(atOnce.map((m) => m.score));
  });

  it("finds a strong candidate that falls beyond the first page", () => {
    // The exact failure the ceiling caused: the only available asset sits
    // last, and a run that stopped after the first page would never see it.
    const buried = [
      ...scorableRun(
        Array.from({ length: 30 }, (_, i) => `b${String(i).padStart(3, "0")}`),
        "PARTIAL"
      ),
      asset({ id: "zzz-the-good-one", availability: "AVAILABLE" }),
    ];

    let merged: ReturnType<typeof rankAssets> = [];
    for (let start = 0; start < buried.length; start += 10) {
      const page = rankAssets(buried.slice(start, start + 10), brief()).filter((m) => m.score > 0);
      merged = mergeTopMatches(merged, page, 5);
    }

    expect(merged[0].assetId).toBe("zzz-the-good-one");
  });

  it("never returns more than the limit", () => {
    let merged: ReturnType<typeof rankAssets> = [];
    for (let p = 0; p < 5; p++) {
      const page = rankAssets(
        scorableRun(
          Array.from({ length: 20 }, (_, i) => `p${p}-${i}`),
          "AVAILABLE"
        ),
        brief()
      );
      merged = mergeTopMatches(merged, page, 6);
      expect(merged.length).toBeLessThanOrEqual(6);
    }
  });

  it("orders ties the same way however the pages are cut", () => {
    // Identical assets, so every score matches and only the id break decides.
    // A comparator that differed between the page sort and the merge would
    // show up here as an order that depends on the page size.
    const same = scorableRun(
      Array.from({ length: 24 }, (_, i) => `t${String(i).padStart(3, "0")}`),
      "AVAILABLE"
    );
    const cut = (size: number) => {
      let merged: ReturnType<typeof rankAssets> = [];
      for (let start = 0; start < same.length; start += size) {
        merged = mergeTopMatches(merged, rankAssets(same.slice(start, start + size), brief()), 8);
      }
      return merged.map((m) => m.assetId);
    };
    expect(cut(3)).toEqual(cut(24));
    expect(cut(7)).toEqual(cut(24));
  });
});
