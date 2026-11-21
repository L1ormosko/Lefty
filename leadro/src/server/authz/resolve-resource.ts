import type { TenantTx } from "@/server/db";
import type { ResourceRef } from "./types";

/** A `ResourceRef` with its derived attributes filled in from the database. */
export interface ResolvedResource {
  orgUnitIds: string[];
  legalEntityIds: string[];
  ownerEmployeeId: string | null;
  assignedEmployeeIds: string[];
  sets: string[];
  /** No org placement at all: only TENANT scopes can match. */
  isTenantLevel: boolean;
}

const unique = (values: Array<string | null | undefined>): string[] => [
  ...new Set(values.filter((value): value is string => typeof value === "string")),
];

/** Active placements as of `now`: started, and not yet ended. */
export const activePlacementWhere = (now: Date) => ({
  effectiveFrom: { lte: now },
  OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
});

/**
 * Turns a `ResourceRef` into the concrete org units / legal entities / owner it stands for.
 *
 * Returns `null` when a referenced org unit, employee or legal entity does not exist in this
 * tenant. Because the lookups run under row-level security, an id belonging to ANOTHER tenant is
 * indistinguishable from a missing one, so a forged cross-tenant id can never be matched against
 * (not even by a TENANT-scoped grant).
 */
export async function resolveResource(
  tx: TenantTx,
  tenantId: string,
  ref: ResourceRef,
  now: Date,
): Promise<ResolvedResource | null> {
  const orgUnitIds: string[] = [];
  const legalEntityIds: string[] = [];
  let ownerEmployeeId = ref.ownerEmployeeId ?? null;

  if (ref.orgUnitId !== undefined) {
    const unit = await tx.orgUnit.findFirst({
      where: { id: ref.orgUnitId, tenantId },
      select: { id: true, legalEntityId: true },
    });
    if (!unit) return null;
    orgUnitIds.push(unit.id);
    if (unit.legalEntityId) legalEntityIds.push(unit.legalEntityId);
  }

  if (ref.employeeId !== undefined) {
    const employee = await tx.employee.findFirst({
      where: { id: ref.employeeId, tenantId },
      select: {
        id: true,
        legalEntityId: true,
        assignments: { where: activePlacementWhere(now), select: { orgUnitId: true } },
      },
    });
    if (!employee) return null;
    // An employee in several units (e.g. a temporary placement) is in scope if ANY is (§3.4).
    orgUnitIds.push(...employee.assignments.map((placement) => placement.orgUnitId));
    if (employee.legalEntityId) legalEntityIds.push(employee.legalEntityId);
    ownerEmployeeId ??= employee.id;
  }

  if (ref.legalEntityId !== undefined) {
    const entity = await tx.legalEntity.findFirst({ where: { id: ref.legalEntityId, tenantId }, select: { id: true } });
    if (!entity) return null;
    legalEntityIds.push(entity.id);
  }

  const resolved = {
    orgUnitIds: unique(orgUnitIds),
    legalEntityIds: unique(legalEntityIds),
    ownerEmployeeId,
    assignedEmployeeIds: ref.assignedEmployeeIds ?? [],
    sets: ref.sets ?? [],
  };
  const isTenantLevel =
    resolved.orgUnitIds.length === 0 &&
    resolved.legalEntityIds.length === 0 &&
    resolved.ownerEmployeeId === null &&
    resolved.assignedEmployeeIds.length === 0;
  return { ...resolved, isTenantLevel };
}
