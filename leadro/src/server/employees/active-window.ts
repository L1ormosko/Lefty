import type { Prisma } from "@prisma/client";

/** A time-bounded row (placement, manager, role assignment) is in effect at `at`: started and not yet ended. */
export const effectiveAt = (at: Date): { effectiveFrom: { lte: Date }; OR: Prisma.OrganizationalAssignmentWhereInput["OR"] } => ({
  effectiveFrom: { lte: at },
  OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
});

/** The row's end, but never at or before its start (the DB requires `effectiveTo > effectiveFrom`). */
export function endInstant(effectiveFrom: Date, wanted: Date): Date {
  return wanted > effectiveFrom ? wanted : new Date(effectiveFrom.getTime() + 1);
}
