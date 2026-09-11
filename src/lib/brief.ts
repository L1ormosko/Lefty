/**
 * Turning a campaign brief into a shortlist of real inventory.
 *
 * This is where VELTO is worth more than a phone call. An advertiser today
 * calls ten owners and asks each "what do you have in Be'er Sheva in November
 * under twenty thousand shekels". We hold the calendar for all of them, so we
 * can answer once.
 *
 * Two rules shape everything below, and both are about not making things up:
 *
 * 1. **Nothing here invents a fact about an asset.** Every score component is
 *    computed from a column an owner filled in or from a booking that exists.
 *    There are no audience numbers, no impressions, no reach estimates - VELTO
 *    has none of that data, and a recommendation engine that produces them is
 *    producing fiction with a ranking attached.
 * 2. **What is missing is said out loud.** Each result carries `gaps`: the
 *    things the shortlist could not take into account because nobody filled
 *    them in. An asset with no published price is not quietly dropped and not
 *    quietly assumed to be affordable - it is ranked lower and labelled.
 *
 * The module is pure: no database, no network, no dates from the clock. That
 * is what lets the ranking be tested, and it is also what lets the optional
 * language model be bolted on without giving it any influence over the result.
 */
import type { AssetType, LocationTag } from "@prisma/client";
import { ASSET_TYPES, LOCATION_TAGS } from "./constants";
import type { AvailabilityState } from "./constants";

/** A campaign brief, after parsing. Every field is optional on purpose. */
export type Brief = {
  cities: string[];
  assetTypes: AssetType[];
  locationTags: LocationTag[];
  startDate: string | null;
  endDate: string | null;
  /** Total budget for the campaign, in whole shekels. */
  budget: number | null;
  digitalOnly: boolean;
  verifiedOnly: boolean;
};

export const EMPTY_BRIEF: Brief = {
  cities: [],
  assetTypes: [],
  locationTags: [],
  startDate: null,
  endDate: null,
  budget: null,
  digitalOnly: false,
  verifiedOnly: false,
};

/* ------------------------------------------------------------------ *
 * Free text -> brief
 * ------------------------------------------------------------------ */

/**
 * Hebrew keywords for each asset type and location tag.
 *
 * A plain word list rather than anything clever. It is the fallback that must
 * work when no language model is configured, so it is deliberately boring and
 * fully testable; the model, when present, only produces the same structure.
 */
const TYPE_WORDS: Record<AssetType, string[]> = {
  BILLBOARD: ["שלט חוצות", "בילבורד", "שלטי חוצות", "חוצות"],
  DIGITAL_BILLBOARD: ["שלט דיגיטלי", "דיגיטלי", "מסך", "מסכים", "led"],
  WALL: ["קיר", "קירות", "ציור קיר"],
  TOTEM: ["טוטם", "טוטמים", "עמוד"],
  BUS_STOP: ["תחנת אוטובוס", "תחנות אוטובוס", "תחנה", "אוטובוס"],
  STREET_FURNITURE: ["ריהוט רחוב", "ספסל", "ספסלים"],
  BANNER: ["באנר", "באנרים", "מתלה", "שילוט רחוב"],
  OTHER: [],
};

const TAG_WORDS: Record<LocationTag, string[]> = {
  CITY_CENTER: ["מרכז העיר", "מרכז עיר", "סיטי", "לב העיר"],
  MALL: ["קניון", "קניונים", "מרכז מסחרי", "מסחרי", "קניות"],
  HIGHWAY: ["כביש מהיר", "כביש 6", "אגרה", "בין עירוני", "בין־עירוני"],
  MAIN_ROAD: ["עורק", "כביש ראשי", "ציר ראשי", "ציר מרכזי"],
  INDUSTRIAL: ["אזור תעשייה", "תעשייה", "אזור תעסוקה", "תעסוקה", "הייטק"],
  RESIDENTIAL: ["מגורים", "שכונה", "שכונות", "שכונת מגורים"],
  TRANSIT_HUB: ["תחנה מרכזית", "רכבת", "צומת", "תחבורה", "מסוף"],
  EDUCATION: ["אוניברסיטה", "מכללה", "סטודנטים", "בית ספר", "קמפוס", "חינוך"],
  HOSPITAL: ["בית חולים", "מרפאה", "סורוקה", "רפואי"],
  STADIUM: ["אצטדיון", "היכל ספורט", "ספורט", "מגרש"],
  BEACH: ["חוף", "טיילת", "ים"],
};

/** Hebrew month names, in the order the Date month index expects. */
const MONTHS = [
  ["ינואר"],
  ["פברואר"],
  ["מרץ", "מרס"],
  ["אפריל"],
  ["מאי"],
  ["יוני"],
  ["יולי"],
  ["אוגוסט"],
  ["ספטמבר"],
  ["אוקטובר"],
  ["נובמבר"],
  ["דצמבר"],
];

function iso(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/** Last day of a month, so "November" ends on the 30th and not the 31st. */
function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * A budget written the way people write it: "20 אלף", "₪30,000", "עד 15000".
 *
 * Returns null rather than guessing when there is no number, because a budget
 * invented from nothing would silently filter out most of the inventory.
 */
export function parseBudget(text: string): number | null {
  // No \b after the Hebrew word: JavaScript's word boundary is defined by the
  // ASCII \w class, so "אלף" at the end of a phrase has no boundary after it
  // and the match would never fire.
  const thousands = /(\d[\d,.]*)\s*(?:אלף|א׳|k(?![a-z]))/i.exec(text);
  if (thousands) {
    const n = Number(thousands[1].replace(/[,]/g, ""));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  }
  // A plain number, optionally with a shekel sign or thousands separators.
  const plain = /(?:₪|תקציב|עד|budget)\D{0,12}?(\d[\d,]{2,})/i.exec(text);
  if (plain) {
    const n = Number(plain[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Dates from free text. Handles an explicit range (`1.11.2026-30.11.2026`), a
 * month name, and nothing else - anything more ambiguous stays null so the
 * form's own date fields are the thing that decides.
 */
export function parseDates(text: string, today: Date): { startDate: string | null; endDate: string | null } {
  const numeric = /(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\s*(?:עד|-|–|until)\s*(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/.exec(
    text
  );
  if (numeric) {
    const year = (v: string | undefined) => {
      if (!v) return today.getUTCFullYear();
      const n = Number(v);
      return n < 100 ? 2000 + n : n;
    };
    return {
      startDate: iso(year(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1])),
      endDate: iso(year(numeric[6]), Number(numeric[5]) - 1, Number(numeric[4])),
    };
  }

  for (let i = 0; i < MONTHS.length; i++) {
    if (!MONTHS[i].some((name) => text.includes(name))) continue;
    // A month already behind us means next year: nobody briefs a campaign for
    // a month that has ended.
    const year = i < today.getUTCMonth() ? today.getUTCFullYear() + 1 : today.getUTCFullYear();
    return { startDate: iso(year, i, 1), endDate: iso(year, i, lastDayOfMonth(year, i)) };
  }

  return { startDate: null, endDate: null };
}

/**
 * Parse a Hebrew brief into the same structure the form produces.
 *
 * `knownCities` comes from the database - the cities that actually have
 * inventory - so a city can never be matched into a brief unless VELTO has
 * something there to show for it.
 */
export function parseBrief(
  text: string,
  options: { knownCities: string[]; today: Date }
): Brief {
  const lower = text.toLowerCase();

  const cities = options.knownCities.filter((city) => text.includes(city));

  const assetTypes = ASSET_TYPES.filter((type) =>
    TYPE_WORDS[type].some((word) => lower.includes(word.toLowerCase()))
  );

  const locationTags = LOCATION_TAGS.filter((tag) =>
    TAG_WORDS[tag].some((word) => lower.includes(word.toLowerCase()))
  );

  const { startDate, endDate } = parseDates(text, options.today);

  return {
    cities,
    // A digital brief should not also be narrowed to the billboard type it
    // happens to mention; the flag does that job on its own.
    assetTypes,
    locationTags,
    startDate,
    endDate,
    budget: parseBudget(text),
    digitalOnly: /דיגיטלי|מסך|led/i.test(text),
    verifiedOnly: /מאומת|מאומתים|רק מאומת/.test(text),
  };
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/** Exactly what the scorer is allowed to look at. */
export type ScorableAsset = {
  id: string;
  city: string;
  assetType: AssetType;
  isDigital: boolean;
  locationTags: LocationTag[];
  widthCm: number | null;
  heightCm: number | null;
  verificationStatus: string;
  hasImage: boolean;
  /** For the brief's window, derived elsewhere - never stored. */
  availability: AvailabilityState;
  /** Price for the brief's window, or null when the owner published none. */
  priceEstimate: number | null;
  /** First sellable day from the brief's start, when the window is not free. */
  nextAvailable: string | null;
};

export type Match = {
  assetId: string;
  score: number;
  /** Why this asset is on the list. Facts, each traceable to a column. */
  reasons: string[];
  /** What could not be taken into account, because nobody filled it in. */
  gaps: string[];
};

/**
 * Score one asset against one brief.
 *
 * The weights are a judgement call and deliberately coarse: availability for
 * the requested dates dominates, because a billboard that is not free is not a
 * candidate at any price. Everything else nudges. Two things that are NOT in
 * the formula are worth naming: distance to a target audience, and expected
 * views. We have neither, so neither is invented here.
 */
export function scoreAsset(asset: ScorableAsset, brief: Brief): Match {
  const reasons: string[] = [];
  const gaps: string[] = [];
  let score = 0;

  if (asset.availability === "AVAILABLE") {
    score += 50;
    reasons.push("avail.AVAILABLE");
  } else if (asset.availability === "PARTIAL") {
    score += 20;
    reasons.push("brief.reason.partial");
  } else if (asset.availability === "OCCUPIED" && asset.nextAvailable) {
    // Kept, but far down: knowing when a taken billboard frees up is the one
    // thing an advertiser cannot find out anywhere else.
    score += 5;
    reasons.push("brief.reason.freesUp");
  }

  if (brief.cities.length && brief.cities.includes(asset.city)) {
    score += 15;
    reasons.push("brief.reason.city");
  }

  if (brief.assetTypes.length && brief.assetTypes.includes(asset.assetType)) {
    score += 10;
    reasons.push("brief.reason.type");
  }

  if (brief.digitalOnly && asset.isDigital) {
    score += 5;
    reasons.push("brief.reason.digital");
  }

  // Location tags are owner-declared, so they add less than a hard fact like
  // availability. Each overlapping tag counts once.
  const overlap = brief.locationTags.filter((tag) => asset.locationTags.includes(tag));
  if (overlap.length) {
    score += Math.min(overlap.length * 6, 18);
    reasons.push("brief.reason.tags");
  } else if (brief.locationTags.length && asset.locationTags.length === 0) {
    gaps.push("brief.gap.noTags");
  }

  if (brief.budget != null) {
    if (asset.priceEstimate == null) {
      // Not dropped and not assumed affordable: ranked below a priced asset
      // that fits, and labelled so the advertiser knows to ask.
      gaps.push("brief.gap.noPrice");
    } else if (asset.priceEstimate <= brief.budget) {
      score += 20;
      reasons.push("brief.reason.withinBudget");
    } else {
      score -= 25;
      gaps.push("brief.gap.overBudget");
    }
  } else if (asset.priceEstimate == null) {
    gaps.push("brief.gap.noPrice");
  }

  if (asset.verificationStatus === "VERIFIED") {
    score += 10;
    reasons.push("brief.reason.verified");
  }

  if (asset.hasImage) score += 4;
  else gaps.push("brief.gap.noImage");

  if (asset.widthCm == null || asset.heightCm == null) gaps.push("brief.gap.noSize");

  return { assetId: asset.id, score, reasons, gaps };
}

/** Rank a set of assets for a brief, best first. Ties break on id, so the order is stable. */
export function rankAssets(assets: ScorableAsset[], brief: Brief): Match[] {
  return assets
    .map((asset) => scoreAsset(asset, brief))
    .sort((a, b) => b.score - a.score || a.assetId.localeCompare(b.assetId));
}

/**
 * Overlay what the advertiser typed into the form onto what was read out of
 * their free text.
 *
 * The form wins every time it says something. Parsing - by rules or by a model
 * - is a convenience, and the moment someone corrects it by hand that
 * correction has to stick, or the page argues with its user.
 */
export function applyExplicit(parsed: Brief, explicit: Partial<Brief>): Brief {
  const merged: Brief = { ...parsed };
  if (explicit.cities?.length) merged.cities = explicit.cities;
  if (explicit.assetTypes?.length) merged.assetTypes = explicit.assetTypes;
  if (explicit.locationTags?.length) merged.locationTags = explicit.locationTags;
  if (explicit.budget != null) merged.budget = explicit.budget;
  if (explicit.startDate && explicit.endDate) {
    merged.startDate = explicit.startDate;
    merged.endDate = explicit.endDate;
  }
  if (explicit.digitalOnly) merged.digitalOnly = true;
  if (explicit.verifiedOnly) merged.verifiedOnly = true;
  return merged;
}

/** True when the brief says nothing at all - the page should then ask, not guess. */
export function isEmptyBrief(brief: Brief): boolean {
  return (
    brief.cities.length === 0 &&
    brief.assetTypes.length === 0 &&
    brief.locationTags.length === 0 &&
    brief.startDate == null &&
    brief.budget == null &&
    !brief.digitalOnly
  );
}
