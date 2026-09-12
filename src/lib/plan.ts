/**
 * What a media owner's subscription permits.
 *
 * VELTO's first revenue is a listing subscription rather than a per-deal
 * commission, and the reason is in the data: Booking.priceEstimate is computed
 * once from the owner's list price, never updated, and labelled "not a binding
 * offer" everywhere it appears. The last event VELTO observes is the owner
 * pressing Approve. There is no figure here that anyone could honestly bill a
 * percentage of.
 *
 * Two rules matter more than the arithmetic:
 *
 *   - No plan row means unlimited. Every owner on the platform today predates
 *     billing, and introducing a table must not silently cap them.
 *   - A lapse never takes live inventory down. An advertiser who found a
 *     billboard yesterday must still find it today; the owner's unpaid invoice
 *     is between VELTO and the owner, and punishing the buyer for it would
 *     make the map unreliable, which is the one thing it cannot be.
 *
 * So a lapse blocks *adding* to what is public, and nothing else.
 */

export type OwnerPlan = {
  activeListingLimit: number;
  paidThrough: Date | null;
};

export type PlanBlock = "lapsed" | "limit";

export type PlanStatus = {
  /** Null when there is no plan: unlimited, and shown as such. */
  limit: number | null;
  activeCount: number;
  /** Null when unlimited. Never negative - see the note in planStatus(). */
  remaining: number | null;
  lapsed: boolean;
  /** May this owner make one more listing public right now? */
  canPublish: boolean;
  /** Why not, when they cannot. */
  block: PlanBlock | null;
};

export function planStatus(
  plan: OwnerPlan | null,
  activeCount: number,
  now: Date = new Date()
): PlanStatus {
  if (!plan) {
    return {
      limit: null,
      activeCount,
      remaining: null,
      lapsed: false,
      canPublish: true,
      block: null,
    };
  }

  const lapsed = plan.paidThrough != null && plan.paidThrough.getTime() < now.getTime();
  // Clamped at zero: an owner who was moved onto a smaller plan can hold more
  // live listings than the new limit allows, and "remaining: -2" is a number
  // no screen should ever have to phrase.
  const remaining = Math.max(0, plan.activeListingLimit - activeCount);

  // Lapse first: it is the more important thing to tell someone, and the fix
  // is different.
  const block: PlanBlock | null = lapsed ? "lapsed" : remaining === 0 ? "limit" : null;

  return {
    limit: plan.activeListingLimit,
    activeCount,
    remaining,
    lapsed,
    canPublish: block === null,
    block,
  };
}

/**
 * Is the plan within `days` of running out?
 *
 * Used to warn before the block bites, rather than at the moment an owner is
 * trying to publish something.
 */
export function expiresWithin(plan: OwnerPlan | null, days: number, now: Date = new Date()): boolean {
  if (!plan?.paidThrough) return false;
  const remaining = plan.paidThrough.getTime() - now.getTime();
  return remaining > 0 && remaining <= days * 24 * 60 * 60 * 1000;
}
