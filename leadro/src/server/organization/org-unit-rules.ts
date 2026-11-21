import { Prisma, type OrgUnitType } from "@prisma/client";
import { explainParentViolation } from "@/lib/org-hierarchy";
import { ConflictError, InvalidStateTransitionError, ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";

/** Business-state rules shared by the org unit write services. */

/** The hierarchy rule for placing a `type` unit under `parent` (null = top level). */
export function assertParentAllowed(type: OrgUnitType, parent: { type: OrgUnitType } | null): void {
  const violation = explainParentViolation(type, parent?.type ?? null);
  if (violation) throw new ValidationError({ message: violation, field: "parentId" });
}

/** A unit can only be extended or hang units beneath it while it is active. */
export function assertActive(unit: { active: boolean }, message: string): void {
  if (!unit.active) throw new InvalidStateTransitionError({ message });
}

/** Address, time zone, locale and opening hours describe a physical branch only. */
export function assertBranchAttributesAllowed(
  type: OrgUnitType,
  attributes: { address?: unknown; timeZone?: unknown; defaultLocale?: unknown; operatingHours?: unknown },
): void {
  if (type === "BRANCH") return;
  for (const key of ["address", "timeZone", "defaultLocale", "operatingHours"] as const) {
    if (attributes[key] !== undefined && attributes[key] !== null) {
      throw new ValidationError({ message: `${key} can only be set on a BRANCH.`, field: key });
    }
  }
}

/** The referenced legal entity must exist in the tenant and still be active. */
export async function assertLegalEntityUsable(
  tx: TenantTx,
  tenantId: string,
  legalEntityId: string | null | undefined,
): Promise<void> {
  if (!legalEntityId) return;
  const entity = await tx.legalEntity.findFirst({ where: { id: legalEntityId, tenantId }, select: { active: true } });
  if (!entity) throw new ValidationError({ message: "The legal entity does not exist.", field: "legalEntityId" });
  if (!entity.active) throw new ValidationError({ message: "The legal entity is archived.", field: "legalEntityId" });
}

/** Active siblings must have distinct names (case-insensitive), or the tree is ambiguous in pickers. */
export async function assertSiblingNameFree(
  tx: TenantTx,
  tenantId: string,
  parentId: string | null,
  name: string,
  excludeUnitId?: string,
): Promise<void> {
  const clash = await tx.orgUnit.findFirst({
    where: {
      tenantId,
      parentId,
      active: true,
      name: { equals: name, mode: "insensitive" },
      ...(excludeUnitId ? { id: { not: excludeUnitId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new ConflictError({ message: "A unit with this name already exists under the same parent.", field: "name" });
}

/** Maps a patch to Prisma data, turning JSON `null` into SQL NULL (Prisma needs a marker for it). */
export function toUnitUpdateData(patch: Record<string, unknown>): Prisma.OrgUnitUncheckedUpdateInput {
  const jsonColumns = new Set(["address", "operatingHours"]);
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    data[key] = jsonColumns.has(key) && value === null ? Prisma.DbNull : value;
  }
  return data as Prisma.OrgUnitUncheckedUpdateInput;
}
