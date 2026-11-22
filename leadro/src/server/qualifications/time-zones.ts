import { resolveTimeZone } from "@/lib/i18n";
import { activePlacementWhere } from "@/server/authz";
import type { TenantTx } from "@/server/db";

/** Deepest org tree we walk; a guard against a corrupted (cyclic) parent chain. */
const MAX_TREE_DEPTH = 20;

/**
 * Time zone of an org unit: the nearest ancestor-or-self that sets one (only branches usually do),
 * else null. Same walk as the display-locale resolution (`server/i18n`), kept here to stay inside
 * the caller's transaction.
 */
export async function orgUnitTimeZone(tx: TenantTx, tenantId: string, orgUnitId: string | null): Promise<string | null> {
  let nextId = orgUnitId;
  for (let depth = 0; nextId && depth < MAX_TREE_DEPTH; depth++) {
    const unit = await tx.orgUnit.findFirst({ where: { id: nextId, tenantId }, select: { parentId: true, timeZone: true } });
    if (!unit) return null;
    if (unit.timeZone) return unit.timeZone;
    nextId = unit.parentId;
  }
  return null;
}

/**
 * The zone a calendar date is read in for work at `orgUnitId` (§16.5): the job's own zone if it has
 * one, else the org unit's (nearest branch), else the company's. Uses the Phase 1 resolution
 * (`resolveTimeZone`), which also skips values the runtime does not know.
 */
export async function resolveWorkTimeZone(
  tx: TenantTx,
  tenantId: string,
  options: { jobTimeZone?: string | null; orgUnitId?: string | null },
): Promise<string> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultTimeZone: true } });
  const branch = await orgUnitTimeZone(tx, tenantId, options.orgUnitId ?? null);
  return resolveTimeZone({ user: options.jobTimeZone, branch, company: tenant.defaultTimeZone });
}

/**
 * The default zone for an employee's weekly availability: their login's zone, else their PRIMARY
 * placement's branch, else the company's. The caller may override it per window.
 */
export async function resolveEmployeeTimeZone(tx: TenantTx, tenantId: string, employeeId: string): Promise<string> {
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: {
      user: { select: { timeZone: true } },
      assignments: { where: { kind: "PRIMARY", ...activePlacementWhere(new Date()) }, select: { orgUnitId: true }, take: 1 },
    },
  });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultTimeZone: true } });
  const branch = await orgUnitTimeZone(tx, tenantId, employee?.assignments[0]?.orgUnitId ?? null);
  return resolveTimeZone({ user: employee?.user?.timeZone, branch, company: tenant.defaultTimeZone });
}
