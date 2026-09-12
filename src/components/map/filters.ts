import type { AvailabilityState } from "@/lib/constants";

/** Filter state lives in the URL, so a search is shareable and back works. */
export type Filters = {
  q: string;
  city: string;
  types: string[];
  availability: AvailabilityState[];
  minPrice: string;
  maxPrice: string;
  startDate: string;
  endDate: string;
  digitalOnly: boolean;
  verifiedOnly: boolean;
};

export const EMPTY_FILTERS: Filters = {
  q: "",
  city: "",
  types: [],
  availability: [],
  minPrice: "",
  maxPrice: "",
  startDate: "",
  endDate: "",
  digitalOnly: false,
  verifiedOnly: false,
};

export function filtersFromParams(params: URLSearchParams): Filters {
  return {
    q: params.get("q") ?? "",
    city: params.get("city") ?? "",
    types: params.get("types")?.split(",").filter(Boolean) ?? [],
    availability: (params.get("availability")?.split(",").filter(Boolean) ?? []) as AvailabilityState[],
    minPrice: params.get("minPrice") ?? "",
    maxPrice: params.get("maxPrice") ?? "",
    startDate: params.get("startDate") ?? "",
    endDate: params.get("endDate") ?? "",
    digitalOnly: params.get("digitalOnly") === "1",
    verifiedOnly: params.get("verifiedOnly") === "1",
  };
}

export function filtersToParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.city) p.set("city", f.city);
  if (f.types.length) p.set("types", f.types.join(","));
  if (f.availability.length) p.set("availability", f.availability.join(","));
  if (f.minPrice) p.set("minPrice", f.minPrice);
  if (f.maxPrice) p.set("maxPrice", f.maxPrice);
  if (f.startDate) p.set("startDate", f.startDate);
  if (f.endDate) p.set("endDate", f.endDate);
  if (f.digitalOnly) p.set("digitalOnly", "1");
  if (f.verifiedOnly) p.set("verifiedOnly", "1");
  return p;
}

/* ------------------------------------------------------------------ *
 * Describing what is on
 * ------------------------------------------------------------------ */

/**
 * One applied filter, in words, with the patch that removes exactly it.
 *
 * `clear` is a partial rather than a key name so a chip can undo a filter that
 * is stored as one item inside an array - removing "billboard" from three
 * selected types must not clear the other two.
 */
export type Chip = {
  /** Stable across renders; also the React key. */
  id: string;
  /** Label key, or a literal when the value is user data (a city name). */
  label: string;
  /** True when `label` is already text rather than a key to translate. */
  literal?: boolean;
  clear: Partial<Filters>;
};

/**
 * Every applied filter as its own chip.
 *
 * One chip per value, not per group. The count this produces is what the
 * mobile filter button shows, and the old counter collapsed `types` and
 * `availability` to one each - so three selected asset types reported as a
 * single active filter and the badge quietly under-reported.
 */
export function describeFilters(f: Filters): Chip[] {
  const chips: Chip[] = [];

  if (f.q) chips.push({ id: "q", label: f.q, literal: true, clear: { q: "" } });
  if (f.city) chips.push({ id: "city", label: f.city, literal: true, clear: { city: "" } });

  for (const type of f.types) {
    chips.push({
      id: `type:${type}`,
      label: `type.${type}`,
      clear: { types: f.types.filter((t) => t !== type) },
    });
  }

  for (const state of f.availability) {
    chips.push({
      id: `avail:${state}`,
      label: `avail.${state}`,
      clear: { availability: f.availability.filter((s) => s !== state) },
    });
  }

  // Price and dates are ranges: one chip, because half a range is not a filter
  // anyone means to keep.
  if (f.minPrice || f.maxPrice) {
    chips.push({ id: "price", label: "filter.priceRange", clear: { minPrice: "", maxPrice: "" } });
  }
  if (f.startDate && f.endDate) {
    chips.push({ id: "dates", label: "filter.dates", clear: { startDate: "", endDate: "" } });
  }

  if (f.digitalOnly) {
    chips.push({ id: "digital", label: "filter.digitalOnly", clear: { digitalOnly: false } });
  }
  if (f.verifiedOnly) {
    chips.push({ id: "verified", label: "filter.verifiedOnly", clear: { verifiedOnly: false } });
  }

  return chips;
}

/** Derived from the chips, so the badge and the chip row can never disagree. */
export function activeFilterCount(f: Filters): number {
  return describeFilters(f).length;
}

/**
 * Which single filter to offer removing when nothing matched.
 *
 * Ordered by how much each one narrows a search in practice, not by how it
 * sits in the form: a date window rules out almost everything, a city rules
 * out the least and is usually the thing the advertiser actually meant.
 *
 * Returns null when no filter is applied - then the answer is not "relax
 * something", it is "there is nothing here", and the caller says that instead.
 *
 * Deliberately suggests loosening rather than quietly widening the result set:
 * showing assets that do not match, unlabelled, would contradict the note
 * three lines away promising that only real matching inventory is listed.
 */
export function suggestRelaxation(f: Filters): Chip | null {
  const chips = describeFilters(f);
  const order = ["dates", "price", "verified", "digital"];

  for (const id of order) {
    const chip = chips.find((c) => c.id === id);
    if (chip) return chip;
  }
  // Then any one asset type, then the city, then free text.
  return (
    chips.find((c) => c.id.startsWith("type:")) ??
    chips.find((c) => c.id.startsWith("avail:")) ??
    chips.find((c) => c.id === "city") ??
    chips.find((c) => c.id === "q") ??
    null
  );
}
