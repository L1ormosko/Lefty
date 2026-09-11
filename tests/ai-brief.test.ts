import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiEnabled, parseBriefText } from "@/server/ai";

/**
 * The language model's blast radius.
 *
 * The feature is only acceptable in a product whose first rule is "never invent
 * inventory, availability or prices" because of one property: the model cannot
 * produce a result, only a filter, and that filter is checked against our own
 * vocabulary before it reaches a query. These tests are that property.
 */

const CITIES = ["באר שבע", "ירושלים"];
const TODAY = new Date(Date.UTC(2026, 8, 11));
const options = { knownCities: CITIES, today: TODAY };

/** A fake Anthropic response carrying whatever JSON the test wants to inject. */
function modelReplies(json: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text: JSON.stringify(json) }] }),
  })) as unknown as typeof fetch;
}

const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-credential";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

describe("without a key", () => {
  it("is off, and says so rather than pretending", () => {
    expect(aiEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(aiEnabled({ ANTHROPIC_API_KEY: "x" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("still answers, using the rules", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const calls = vi.fn();
    vi.stubGlobal("fetch", calls);

    const result = await parseBriefText("קמפיין בבאר שבע בנובמבר", options);
    expect(result.source).toBe("rules");
    expect(result.brief.cities).toEqual(["באר שבע"]);
    // Nothing was sent anywhere. A missing key must not become a silent
    // outbound request.
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("what the model is allowed to influence", () => {
  it("uses a well-formed answer", async () => {
    vi.stubGlobal(
      "fetch",
      modelReplies({
        cities: ["ירושלים"],
        assetTypes: ["BILLBOARD"],
        locationTags: ["MALL"],
        startDate: "2026-11-01",
        endDate: "2026-11-30",
        budget: 40000,
        digitalOnly: false,
      })
    );
    const result = await parseBriefText("משהו", options);
    expect(result.source).toBe("model");
    expect(result.brief.cities).toEqual(["ירושלים"]);
    expect(result.brief.budget).toBe(40000);
  });

  it("discards a city we have no inventory in", async () => {
    // The failure this prevents: a shortlist headed "your campaign in Eilat"
    // for a city VELTO has never had a single asset in.
    vi.stubGlobal("fetch", modelReplies({ cities: ["אילת", "ירושלים"], budget: null }));
    const result = await parseBriefText("משהו", options);
    expect(result.brief.cities).toEqual(["ירושלים"]);
  });

  it("discards asset types and tags it made up", async () => {
    vi.stubGlobal(
      "fetch",
      modelReplies({ assetTypes: ["BLIMP", "BILLBOARD"], locationTags: ["AIRPORT", "MALL"] })
    );
    const result = await parseBriefText("משהו", options);
    expect(result.brief.assetTypes).toEqual(["BILLBOARD"]);
    expect(result.brief.locationTags).toEqual(["MALL"]);
  });

  it("drops a backwards or half-stated date range", async () => {
    vi.stubGlobal("fetch", modelReplies({ startDate: "2026-11-30", endDate: "2026-11-01" }));
    const backwards = await parseBriefText("משהו", options);
    expect(backwards.brief.startDate).toBeNull();
    expect(backwards.brief.endDate).toBeNull();

    vi.stubGlobal("fetch", modelReplies({ startDate: "2026-11-01", endDate: null }));
    const half = await parseBriefText("משהו", options);
    expect(half.brief.startDate).toBeNull();
  });
});

describe("when the model fails", () => {
  it("falls back to the rules on a bad status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch
    );
    const result = await parseBriefText("קמפיין בבאר שבע", options);
    expect(result.source).toBe("rules");
    expect(result.brief.cities).toEqual(["באר שבע"]);
  });

  it("falls back on an answer that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "בשמחה! הנה ההמלצות שלי" }] }),
      })) as unknown as typeof fetch
    );
    const result = await parseBriefText("קמפיין בבאר שבע", options);
    expect(result.source).toBe("rules");
  });

  it("falls back when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    );
    const result = await parseBriefText("קמפיין בבאר שבע", options);
    // The advertiser gets a shortlist in every failure path. That is the
    // difference between an optional enhancement and a dependency.
    expect(result.source).toBe("rules");
    expect(result.brief.cities).toEqual(["באר שבע"]);
  });
});
