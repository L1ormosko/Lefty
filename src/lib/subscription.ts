/**
 * Who may see the inventory, and who may add to it.
 *
 * VELTO sells two different things on one row. An advertiser pays to see where
 * the signs are, what they cost and who to call. A media owner pays for how
 * many listings they may keep public. A company that does both has one
 * subscription and both permissions.
 *
 * Every new account is given a free trial, and when it runs out the map does
 * not go dark - it goes vague. That distinction is the whole design: a visitor
 * still sees that there are eleven spaces in Be'er Sheva and roughly where,
 * because a marketplace nobody can look into has no way to attract the side
 * that pays. What they stop seeing is the exact spot, the price, the dates and
 * the owner's contact details - which is the part VELTO actually sells.
 *
 * Nothing here charges anyone. There is no card processing in this product;
 * `paidThrough` is set by hand against an invoice raised elsewhere.
 */

/** The gift at registration. Stated once, here, rather than in four files. */
export const TRIAL_DAYS = 7;

/** The minimum term a paying customer commits to, in months. */
export const COMMITMENT_MONTHS = 6;

export type Subscription = {
  trialEndsAt: Date | null;
  paidThrough: Date | null;
};

export type AccessState =
  /** Inside the free trial. Full access, and the screen says how long is left. */
  | "trial"
  /** Paid up. Full access. */
  | "paid"
  /** Had access and it ran out. */
  | "lapsed"
  /** Never had any - an account created before trials existed. */
  | "none";

export type Access = {
  state: AccessState;
  /** May this viewer see exact locations, prices, availability and contacts? */
  full: boolean;
  /** Whole days left of the trial, for the banner. Null outside a live trial. */
  trialDaysLeft: number | null;
};

/**
 * Access plus who is asking.
 *
 * `state` alone cannot tell a signed-in account with no subscription apart
 * from a visitor with no account: both are "none". Every screen that gates
 * content needs the difference, because the two people need opposite things
 * said to them - one should register, the other already has and needs a way
 * to pay. Getting this wrong is what put "open an account" and "already have
 * an account?" in front of a customer who was signed in at the time.
 */
export type ViewerAccess = Access & {
  /** Full access by role rather than by payment. */
  admin: boolean;
  /** There is a session. Not the same as having access. */
  signedIn: boolean;
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * What this account may see right now.
 *
 * `null` is an anonymous visitor - no account at all - and gets the same
 * restricted view as a lapsed one. Admins are handled by the caller, which
 * knows the role; this function deliberately knows nothing about roles so that
 * the rule cannot drift between the two places it is asked.
 */
export function access(subscription: Subscription | null, now: Date = new Date()): Access {
  const t = now.getTime();

  const paidUntil = subscription?.paidThrough?.getTime() ?? null;
  if (paidUntil != null && paidUntil >= t) {
    return { state: "paid", full: true, trialDaysLeft: null };
  }

  const trialUntil = subscription?.trialEndsAt?.getTime() ?? null;
  if (trialUntil != null && trialUntil >= t) {
    return {
      state: "trial",
      full: true,
      // Rounded up: someone with four hours left has "one day", not "zero
      // days", which would read as though the trial had already ended.
      trialDaysLeft: Math.max(1, Math.ceil((trialUntil - t) / DAY)),
    };
  }

  // Ever had anything at all? A brand-new row with neither date is "none";
  // a row whose dates have passed is "lapsed". They read differently to the
  // person looking at the screen, and they deserve different copy.
  const everHad = paidUntil != null || trialUntil != null;
  return { state: everHad ? "lapsed" : "none", full: false, trialDaysLeft: null };
}

/** When a trial granted now would end. */
export function trialEnd(from: Date = new Date()): Date {
  return new Date(from.getTime() + TRIAL_DAYS * DAY);
}

/** Is the trial close enough to its end to be worth warning about? */
export function trialEndingSoon(a: Access): boolean {
  return a.state === "trial" && a.trialDaysLeft != null && a.trialDaysLeft <= 3;
}

/**
 * The precision a restricted viewer gets for a sign's position.
 *
 * Rounded to roughly a few hundred metres, which puts the pin in the right
 * neighbourhood and nowhere near the right street corner. Deliberately done by
 * rounding rather than by adding noise: rounding is stable, so the same sign
 * does not jitter around the map between requests, and repeated loads cannot
 * be averaged to recover the true position.
 */
export function coarse(value: number): number {
  return Math.round(value * 250) / 250;
}
