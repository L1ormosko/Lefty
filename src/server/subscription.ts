import "server-only";
import { prisma } from "./db";
import { planStatus, type PlanStatus } from "@/lib/plan";
import { access, trialEnd, type ViewerAccess } from "@/lib/subscription";

/**
 * A media owner's subscription state, as of right now.
 *
 * Derived on every read rather than stored: this deployment has no scheduler,
 * and a `lapsed` column that only flips when a cron happens to run is a column
 * that is wrong most of the time it matters.
 *
 * The active count is the same number the map counts - ACTIVE assets - so an
 * owner's "2 of 3 published" can never disagree with what a buyer can see.
 */
export async function ownerPlanStatus(userId: string): Promise<PlanStatus> {
  const [plan, activeCount] = await Promise.all([
    prisma.subscription.findUnique({
      where: { userId },
      select: { activeListingLimit: true, paidThrough: true },
    }),
    prisma.mediaAsset.count({ where: { ownerId: userId, status: "ACTIVE" } }),
  ]);

  return planStatus(plan, activeCount);
}

/** The full row, for the owner's own plan panel and for the admin screen. */
export async function ownerPlanRow(userId: string) {
  return prisma.subscription.findUnique({ where: { userId } });
}

/**
 * What this viewer may see of the inventory.
 *
 * The single place the question is asked, so the map, the asset page and the
 * API cannot drift apart on it. Admins see everything: they are the people who
 * verify listings, and a verifier who cannot see the address is useless.
 */
export async function viewerAccess(
  user: { id: string; role: string } | null
): Promise<ViewerAccess> {
  // `signedIn` matters as much as `full`. Without it every screen that gates
  // content told a logged-in customer to "open an account" and asked whether
  // they "already had one" - the copy for a stranger, shown to someone whose
  // name is in the header. The subscription state alone cannot tell those two
  // people apart, because a signed-in account with no subscription row and an
  // anonymous visitor both come out as "none".
  if (!user) return { ...access(null), admin: false, signedIn: false };
  if (user.role === "ADMIN") {
    return { state: "paid", full: true, trialDaysLeft: null, admin: true, signedIn: true };
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
    select: { trialEndsAt: true, paidThrough: true },
  });
  return { ...access(subscription), admin: false, signedIn: true };
}

/**
 * Give an account its free trial.
 *
 * Registration creates the row alongside the user, so this exists for accounts
 * that predate trials - an admin granting one by hand. Idempotent on the
 * unique userId, so it can never hand out a second week.
 */
export async function grantTrial(userId: string) {
  await prisma.subscription.upsert({
    where: { userId },
    create: { userId, trialEndsAt: trialEnd() },
    update: {},
  });
}
