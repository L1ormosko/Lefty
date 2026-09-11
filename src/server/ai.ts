import "server-only";

import { z } from "zod";
import { ASSET_TYPES, LOCATION_TAGS } from "@/lib/constants";
import { EMPTY_BRIEF, parseBrief, type Brief } from "@/lib/brief";

/**
 * Optional language-model parsing of a free-text brief.
 *
 * The safety property that makes this acceptable in a product whose first rule
 * is "never invent inventory, availability, audiences or prices" is the shape
 * of the contract: **the model never sees the inventory and never produces a
 * result.** It is handed a sentence in Hebrew and asked for a filter set. Its
 * answer is then validated against our own enums and the real city list, and
 * anything it made up is discarded before it reaches a query. The ranking, the
 * prices and the availability all come from the database either way.
 *
 * Without ANTHROPIC_API_KEY the rule-based parser in lib/brief.ts runs instead.
 * That is not a degraded mode hidden behind an "AI" label - the page says which
 * one answered. A button that quietly does nothing when a key is missing is the
 * kind of fake feature this project does not ship.
 */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 8_000;

export function aiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * What the model is allowed to return. Anything outside this is dropped rather
 * than corrected: a hallucinated city is not a near miss to be repaired, it is
 * a place we have no inventory in.
 */
const modelBriefSchema = z.object({
  cities: z.array(z.string()).max(10).default([]),
  assetTypes: z.array(z.string()).max(8).default([]),
  locationTags: z.array(z.string()).max(11).default([]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  budget: z.number().int().positive().nullable().default(null),
  digitalOnly: z.boolean().default(false),
});

function systemPrompt(knownCities: string[], today: string): string {
  return [
    "You convert a Hebrew outdoor-advertising campaign brief into a filter object.",
    "Return ONLY a JSON object, no prose and no code fence.",
    "",
    "Fields: cities (string[]), assetTypes (string[]), locationTags (string[]),",
    "startDate (YYYY-MM-DD or null), endDate (YYYY-MM-DD or null),",
    "budget (integer shekels for the whole campaign, or null), digitalOnly (boolean).",
    "",
    `Today is ${today}. A month named without a year means the next occurrence.`,
    "",
    `cities MUST come from this list, verbatim: ${knownCities.join(" | ") || "(none)"}`,
    `assetTypes MUST come from: ${ASSET_TYPES.join(" | ")}`,
    `locationTags MUST come from: ${LOCATION_TAGS.join(" | ")}`,
    "",
    "Omit anything the brief does not state. Never guess a budget, a city or a",
    "date that is not there - an empty field is correct and a wrong one is not.",
  ].join("\n");
}

/** Keep only values that exist in our own vocabulary. */
function sanitize(raw: z.infer<typeof modelBriefSchema>, knownCities: string[]): Brief {
  const cities = raw.cities.filter((c) => knownCities.includes(c));
  const assetTypes = raw.assetTypes.filter((t) =>
    (ASSET_TYPES as string[]).includes(t)
  ) as Brief["assetTypes"];
  const locationTags = raw.locationTags.filter((t) =>
    (LOCATION_TAGS as string[]).includes(t)
  ) as Brief["locationTags"];

  // A start without an end (or a backwards range) is not a window, so both go.
  const ordered = raw.startDate && raw.endDate && raw.startDate <= raw.endDate;

  return {
    ...EMPTY_BRIEF,
    cities,
    assetTypes,
    locationTags,
    startDate: ordered ? raw.startDate : null,
    endDate: ordered ? raw.endDate : null,
    budget: raw.budget,
    digitalOnly: raw.digitalOnly,
  };
}

export type ParseResult = { brief: Brief; source: "model" | "rules" };

/**
 * Parse a brief, preferring the model when one is configured.
 *
 * Every failure path - no key, a network error, a timeout, a non-JSON answer,
 * a schema violation - lands on the rule-based parser. The advertiser gets a
 * usable shortlist in all of them, which is the difference between an optional
 * enhancement and a dependency.
 */
export async function parseBriefText(
  text: string,
  options: { knownCities: string[]; today: Date }
): Promise<ParseResult> {
  const fallback = (): ParseResult => ({
    brief: parseBrief(text, options),
    source: "rules",
  });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !text.trim()) return fallback();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: systemPrompt(options.knownCities, options.today.toISOString().slice(0, 10)),
        messages: [{ role: "user", content: text.slice(0, 2000) }],
      }),
    });
    if (!res.ok) {
      console.error("[velto] brief model returned", res.status);
      return fallback();
    }
    const body = await res.json();
    const content = body?.content?.[0]?.text;
    if (typeof content !== "string") return fallback();

    // The model is asked for bare JSON, but a stray fence or a sentence in
    // front of it should not cost the advertiser their answer.
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return fallback();

    const parsed = modelBriefSchema.safeParse(JSON.parse(content.slice(start, end + 1)));
    if (!parsed.success) return fallback();

    return { brief: sanitize(parsed.data, options.knownCities), source: "model" };
  } catch (err) {
    console.error("[velto] brief model failed, using rules:", err);
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}
