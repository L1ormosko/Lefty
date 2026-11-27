import type { Prisma } from "@prisma/client";
import { placementAt, type KpiFact } from "@/lib/kpi-aggregation";
import { MAX_SOURCE_ROWS, assertWithinRowCap, rangeOf, type KpiFactLoader } from "./compute-context";
import { ledJobFacts, primaryPlacements } from "./operational-facts";

/**
 * Employee productivity (spec 13.1): completed jobs per RECORDED shift hour, a group figure for development use. LEADRO models no
 * shift schedule, so the time base is the shifts employees clocked (`Shift.startedAt` to `endedAt`). Jobs come from `ledJobFacts`
 * (lead technician's placement at completion); hours from ENDED shifts started in the range, attributed to the employee's
 * PRIMARY placement at the shift start (spec 3). Employees are never returned: the aggregation sees only units and hours.
 */

const MS_PER_HOUR = 3_600_000;

const employeeProductivity: KpiFactLoader = async (context) => {
  const jobs = (await ledJobFacts(context)).map(({ contributorId: _employee, ...fact }) => fact);
  const shifts = assertWithinRowCap(
    await context.tx.shift.findMany({
      where: context.where<Prisma.ShiftWhereInput>({ tenantId: context.tenantId, status: "ENDED", startedAt: rangeOf(context), endedAt: { not: null } }),
      select: { id: true, employeeId: true, startedAt: true, endedAt: true },
      orderBy: { id: "asc" },
      take: MAX_SOURCE_ROWS + 1,
    }),
  );
  const placementsOf = await primaryPlacements(context, [...new Set(shifts.map((shift) => shift.employeeId))]);
  const hours: KpiFact[] = [];
  for (const shift of shifts) {
    const worked = ((shift.endedAt as Date).getTime() - shift.startedAt.getTime()) / MS_PER_HOUR;
    const orgUnitId = placementAt(placementsOf.get(shift.employeeId) ?? [], shift.startedAt);
    if (worked <= 0 || orgUnitId === null || !context.unitVisible(orgUnitId)) continue;
    hours.push({ recordId: shift.id, at: shift.startedAt, orgUnitId, hours: worked });
  }
  return [...jobs, ...hours];
};

export const PRODUCTIVITY_LOADERS: Record<string, KpiFactLoader> = { employee_productivity: employeeProductivity };
