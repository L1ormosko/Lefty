import type { Prisma } from "@prisma/client";

/**
 * The ONE definition of "in effect" for time-bounded rows, as Prisma where-fragments. Placements,
 * manager rows and role assignments all use `effectiveFrom` / `effectiveTo` (exclusive end), and
 * must agree on what "now" means, or a person could be in scope for one check and out for another.
 */

/** Started (`effectiveFrom <= at`) and not yet ended: the row is in effect at `at`. */
export const activePlacementWhere = (
  at: Date,
): { effectiveFrom: { lte: Date }; OR: Array<{ effectiveTo: null } | { effectiveTo: { gt: Date } }> } => ({
  effectiveFrom: { lte: at },
  OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
});

/** Not yet ended at `at`: in effect now OR scheduled for the future ("open" rows, ignoring the start). */
export const openEndedWhere = (at: Date): { OR: Array<{ effectiveTo: null } | { effectiveTo: { gt: Date } }> } => ({
  OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
});

/** A role assignment that is not revoked and not yet expired: live now or still to start. */
export const liveOrFutureAssignmentWhere = (at: Date): Prisma.RoleAssignmentWhereInput => ({
  revokedAt: null,
  ...openEndedWhere(at),
});
