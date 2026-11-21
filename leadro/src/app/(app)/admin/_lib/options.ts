import type { OrgUnitType } from "@prisma/client";
import type { TranslateFn } from "@/lib/i18n";
import { ForbiddenError, type Actor } from "@/server/core";
import { listEmployees } from "@/server/employees";
import { listLegalEntities, listOrgUnits } from "@/server/organization";
import { listRoles } from "@/server/roles";
import { fullNameOf } from "./format";

/**
 * Data for the pickers inside admin forms. Each loader goes through the same scope-filtered
 * service as the lists, so a picker never offers something the caller could not see. A caller who
 * lacks the permission gets an empty list (the form simply has nothing to choose from).
 */

/** Upper bound of a picker; beyond it the caller is expected to narrow down elsewhere. */
export const PICKER_LIMIT = 200;

/** Unit fields the pages use. `Partial` because field projection may omit any of them. */
export interface UnitSummary {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  code: string | null;
  active: boolean;
  legalEntityId: string | null;
  address: unknown;
  timeZone: string | null;
  defaultLocale: string | null;
  operatingHours: unknown;
}

async function orEmpty<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof ForbiddenError) return [];
    throw error;
  }
}

/**
 * Org units the caller may see (active only unless `active: "all"`), pages followed until `maxPages` (default 5 x 200). The tree
 * and the parent pickers need the whole set, not one page.
 */
export function loadActiveUnits(
  actor: Actor,
  { maxPages = 5, type, active = "true" }: { maxPages?: number; type?: OrgUnitType; active?: "true" | "all" } = {},
): Promise<UnitSummary[]> {
  return orEmpty(async () => {
    const units: UnitSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await listOrgUnits(actor, {
        limit: PICKER_LIMIT,
        cursor,
        active,
        type,
      });
      units.push(...(result.data as unknown as UnitSummary[]));
      cursor = result.page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return units;
  });
}

export function unitOptions(units: readonly UnitSummary[], t: TranslateFn): Array<{ value: string; label: string }> {
  return units.map((unit) => ({ value: unit.id, label: `${unit.name} (${t(`ORG_UNIT_TYPE.${unit.type}`)})` }));
}

/** Active employees the caller may see, as `{ value: id, label: "Last, First" }`. */
export function loadEmployeeOptions(actor: Actor): Promise<Array<{ value: string; label: string }>> {
  return orEmpty(async () => {
    const page = await listEmployees(actor, { limit: PICKER_LIMIT, status: "ACTIVE" });
    return page.data
      .filter((employee) => typeof employee.id === "string")
      .map((employee) => ({
        value: String(employee.id),
        label: fullNameOf(employee) || String(employee.employeeNumber ?? employee.id),
      }));
  });
}

/** Active legal entities the caller may see. */
export function loadLegalEntityOptions(actor: Actor): Promise<Array<{ value: string; label: string }>> {
  return orEmpty(async () => {
    const page = await listLegalEntities(actor, { limit: PICKER_LIMIT, active: "true" });
    return page.data.map((entity) => ({ value: String(entity.id), label: String(entity.name ?? entity.id) }));
  });
}

/** Active roles the caller may see (`permissions.view`), for invitation and assignment forms. */
export function loadRoleOptions(actor: Actor): Promise<Array<{ value: string; label: string }>> {
  return orEmpty(async () => {
    const page = await listRoles(actor, { limit: PICKER_LIMIT, active: "true" });
    return page.data.map((role) => ({ value: String(role.id), label: String(role.name ?? role.id) }));
  });
}
