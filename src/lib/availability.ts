/**
 * Availability is derived, never stored.
 *
 *   owner-declared AvailabilityPeriods   (where the asset may be sold)
 * - APPROVED bookings                    (where it is already sold)
 * = what an advertiser can actually buy for a given window.
 */
import type { AvailabilityState } from "./constants";
import { addDays, daysBetween, rangesOverlap, toUtcDate } from "./dates";

export type Period = { startDate: Date; endDate: Date };

export type AvailabilityInput = {
  status: "DRAFT" | "ACTIVE" | "INACTIVE";
  verificationStatus: "PENDING" | "VERIFIED" | "REJECTED";
  periods: Period[];
  approvedBookings: Period[];
};

/** Days of [start,end] that fall inside at least one declared period. */
function coveredDays(start: Date, end: Date, periods: Period[]): number {
  let covered = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (periods.some((p) => d >= toUtcDate(p.startDate) && d <= toUtcDate(p.endDate))) covered++;
  }
  return covered;
}

/** Days of [start,end] taken by an approved booking. */
function bookedDays(start: Date, end: Date, bookings: Period[]): number {
  let booked = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (bookings.some((b) => d >= toUtcDate(b.startDate) && d <= toUtcDate(b.endDate))) booked++;
  }
  return booked;
}

/**
 * Availability for a specific window. When no window is given, the answer
 * describes the asset "in general" (does it have any sellable day left at all).
 */
export function availabilityFor(
  asset: AvailabilityInput,
  window?: { start: Date; end: Date }
): AvailabilityState {
  if (asset.status !== "ACTIVE") return "INACTIVE";
  if (asset.verificationStatus === "REJECTED") return "INACTIVE";
  if (asset.verificationStatus === "PENDING") return "PENDING_VERIFICATION";

  if (!window) {
    if (asset.periods.length === 0) return "OCCUPIED";
    const anyFree = asset.periods.some((p) => {
      const s = toUtcDate(p.startDate);
      const e = toUtcDate(p.endDate);
      const total = daysBetween(s, e);
      return bookedDays(s, e, asset.approvedBookings) < total;
    });
    return anyFree ? "AVAILABLE" : "OCCUPIED";
  }

  const { start, end } = window;
  const total = daysBetween(start, end);
  if (total <= 0) return "OCCUPIED";

  const covered = coveredDays(start, end, asset.periods);
  if (covered === 0) return "OCCUPIED";

  const conflicting = asset.approvedBookings.filter((b) =>
    rangesOverlap(start, end, toUtcDate(b.startDate), toUtcDate(b.endDate))
  );
  const taken = bookedDays(start, end, conflicting);

  const sellable = covered - taken;
  if (sellable <= 0) return "OCCUPIED";
  if (sellable === total) return "AVAILABLE";
  return "PARTIAL";
}

/** The first day from `from` onward that the asset can be sold, if any. */
export function nextAvailableDate(asset: AvailabilityInput, from: Date, horizonDays = 365): Date | null {
  if (asset.status !== "ACTIVE" || asset.verificationStatus !== "VERIFIED") return null;
  for (let i = 0; i < horizonDays; i++) {
    const d = addDays(from, i);
    const inPeriod = asset.periods.some(
      (p) => d >= toUtcDate(p.startDate) && d <= toUtcDate(p.endDate)
    );
    if (!inPeriod) continue;
    const taken = asset.approvedBookings.some(
      (b) => d >= toUtcDate(b.startDate) && d <= toUtcDate(b.endDate)
    );
    if (!taken) return d;
  }
  return null;
}

/** Price estimate for a window. Returns null when the owner published no price. */
export function estimatePrice(
  asset: { priceWeekly: number | null; priceMonthly: number | null },
  days: number
): number | null {
  if (days <= 0) return null;
  if (asset.priceMonthly != null && days >= 28) {
    return Math.round((asset.priceMonthly / 30) * days);
  }
  if (asset.priceWeekly != null) return Math.round((asset.priceWeekly / 7) * days);
  if (asset.priceMonthly != null) return Math.round((asset.priceMonthly / 30) * days);
  return null;
}
