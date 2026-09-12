/**
 * How ready a listing is to be found and taken seriously.
 *
 * Deliberately NOT a score out of a hundred. Etsy, eBay, Booking and Amazon
 * all run some version of a listing-quality signal; the one that survives
 * scrutiny is Amazon's, because it buckets listings into plain words rather
 * than inventing a precise-looking number. At VELTO's size a percentage would
 * be false precision twice over - there is no corpus to calibrate against, and
 * a two-point difference between two listings would mean nothing.
 *
 * A second honesty note worth keeping next to the code: research for this
 * feature found no published evidence that completeness indicators actually
 * improve listing quality on any platform. It is industry practice, not a
 * measured effect. So this tells an owner what a buyer will not be able to see
 * about their space - a statement of fact - rather than promising more views.
 *
 * Pure, so node-vitest can cover it: the project has no jsdom and cannot test
 * components.
 */

/** A field a buyer looks for, and whether this listing has it. */
export type ReadinessItem =
  | "photo"
  | "price"
  | "availability"
  | "dimensions"
  | "description"
  | "surroundings";

/** Everything the check reads. Nothing here is derived or guessed. */
export type ReadinessInput = {
  imageCount: number;
  priceMonthly: number | null;
  priceWeekly: number | null;
  /** Availability windows that have not already ended. */
  futurePeriodCount: number;
  widthCm: number | null;
  heightCm: number | null;
  description: string | null;
  locationTags: string[];
};

/**
 * Plain words, not a number. "ready" means a buyer can answer the three
 * questions that decide a shortlist - what does it look like, what does it
 * cost, when is it free - without contacting anyone.
 */
export type ReadinessLevel = "incomplete" | "ready" | "strong";

export type Readiness = {
  level: ReadinessLevel;
  /** What a buyer cannot see. Ordered by how much it costs the owner. */
  missing: ReadinessItem[];
  /** Present, for rendering a filled/unfilled list rather than only gaps. */
  present: ReadinessItem[];
};

/**
 * The three that decide whether a listing is answerable at all. An asset can
 * be published without any of them - publishAssetAction only requires a title,
 * a location and one photo - so a listing can be live and still tell a buyer
 * nothing about price or dates.
 */
const ESSENTIAL: ReadinessItem[] = ["photo", "price", "availability"];

/** Ordered by what a buyer misses most, which is also the order to fix them. */
const ORDER: ReadinessItem[] = [
  "photo",
  "price",
  "availability",
  "dimensions",
  "description",
  "surroundings",
];

export function listingReadiness(input: ReadinessInput): Readiness {
  const has: Record<ReadinessItem, boolean> = {
    photo: input.imageCount > 0,
    price: input.priceMonthly != null || input.priceWeekly != null,
    availability: input.futurePeriodCount > 0,
    dimensions: input.widthCm != null && input.heightCm != null,
    description: (input.description ?? "").trim().length > 0,
    surroundings: input.locationTags.length > 0,
  };

  const missing = ORDER.filter((item) => !has[item]);
  const present = ORDER.filter((item) => has[item]);

  const essentialsMissing = ESSENTIAL.some((item) => !has[item]);
  // "strong" is everything, not a threshold - a listing one field short is
  // "ready", and saying so is more useful than a 83% that means nothing.
  const level: ReadinessLevel = essentialsMissing
    ? "incomplete"
    : missing.length === 0
      ? "strong"
      : "ready";

  return { level, missing, present };
}
