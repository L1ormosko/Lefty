/**
 * What a dashboard shows before there is anything to show.
 *
 * A new media owner currently lands on four stat tiles reading 0, 0, 0, ₪0.
 * Four zeros are worse than nothing: they say the product has nothing for this
 * person, and they say it in the place where the product is supposed to make
 * its case. Shopify's merchant home solves this by not rendering the metrics
 * section at all until the store has made a sale - before that, Home is a
 * setup checklist. That is the pattern here.
 *
 * The two sides get the same three stages for the same reason, but they are
 * reached by different events, because "nothing has happened yet" means
 * something different to someone selling space and someone buying it.
 *
 * Pure: node-vitest can cover it, and this project has no jsdom so logic that
 * matters has to live outside components to be testable at all.
 */

export type HomeStage =
  /** Nothing published / nothing asked for. Show the checklist, no metrics. */
  | "empty"
  /** Set up, but no counterparty has appeared yet. Metrics would all be zero. */
  | "waiting"
  /** Something real has happened. Metrics now describe something. */
  | "active";

export type OwnerCounts = {
  assets: number;
  /** Inquiries across all of this owner's assets, any status. */
  inquiries: number;
  /** Bookings across all of this owner's assets, any status. */
  bookings: number;
};

export type AdvertiserCounts = {
  /** Inquiries this advertiser has sent, any status. */
  requests: number;
  bookings: number;
  saved: number;
};

/**
 * An owner with no assets has nothing to measure. An owner with assets but no
 * inquiries has a real thing to show - their inventory - but every activity
 * number would be zero, so the page leads with getting the listings right
 * rather than with a row of noughts.
 */
export function ownerStage(counts: OwnerCounts): HomeStage {
  if (counts.assets === 0) return "empty";
  if (counts.inquiries === 0 && counts.bookings === 0) return "waiting";
  return "active";
}

/**
 * Saving a space is not activity - it is a bookmark, and an advertiser can
 * have a dozen and still be at the very beginning. Only a sent request or a
 * booking counts as something having happened.
 */
export function advertiserStage(counts: AdvertiserCounts): HomeStage {
  if (counts.requests === 0 && counts.bookings === 0) {
    return counts.saved > 0 ? "waiting" : "empty";
  }
  return "active";
}

/* ------------------------------------------------------------------ *
 * The work queue
 * ------------------------------------------------------------------ */

/**
 * One thing waiting for this person, pointing at the page where it is done.
 *
 * Every kind below is a count of real rows. There is deliberately no "you
 * could be earning more" or "listings like yours get N views" - the product
 * has no such number and will not invent one.
 */
export type TaskKind =
  // Owner
  | "inquiries-to-answer"
  | "bookings-to-decide"
  | "listings-incomplete"
  | "contracts-ending"
  // Advertiser
  | "replies-to-read"
  | "bookings-approved"
  | "saved-freeing-soon";

export type Task = { kind: TaskKind; count: number; href: string };

/** Drops anything with a count of zero: an empty queue renders as no queue. */
function nonEmpty(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.count > 0);
}

export function ownerTasks(input: {
  pendingInquiries: number;
  requestedBookings: number;
  incompleteListings: number;
  contractsEndingSoon: number;
}): Task[] {
  return nonEmpty([
    { kind: "inquiries-to-answer", count: input.pendingInquiries, href: "/owner/inquiries" },
    { kind: "bookings-to-decide", count: input.requestedBookings, href: "/owner/bookings" },
    { kind: "listings-incomplete", count: input.incompleteListings, href: "/owner/assets" },
    { kind: "contracts-ending", count: input.contractsEndingSoon, href: "/owner/bookings" },
  ]);
}

export function advertiserTasks(input: {
  respondedInquiries: number;
  approvedBookings: number;
  savedFreeingSoon: number;
}): Task[] {
  return nonEmpty([
    { kind: "replies-to-read", count: input.respondedInquiries, href: "/dashboard/requests" },
    { kind: "bookings-approved", count: input.approvedBookings, href: "/dashboard/bookings" },
    { kind: "saved-freeing-soon", count: input.savedFreeingSoon, href: "/dashboard/saved" },
  ]);
}
