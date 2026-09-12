import "server-only";
import { prisma } from "./db";
import { planStatus, type PlanStatus } from "@/lib/plan";

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
    prisma.ownerPlan.findUnique({
      where: { userId },
      select: { activeListingLimit: true, paidThrough: true },
    }),
    prisma.mediaAsset.count({ where: { ownerId: userId, status: "ACTIVE" } }),
  ]);

  return planStatus(plan, activeCount);
}

/** The full row, for the owner's own plan panel and for the admin screen. */
export async function ownerPlanRow(userId: string) {
  return prisma.ownerPlan.findUnique({ where: { userId } });
}
