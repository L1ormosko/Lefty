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

export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.city) n++;
  if (f.types.length) n++;
  if (f.availability.length) n++;
  if (f.minPrice || f.maxPrice) n++;
  if (f.startDate && f.endDate) n++;
  if (f.digitalOnly) n++;
  if (f.verifiedOnly) n++;
  return n;
}
