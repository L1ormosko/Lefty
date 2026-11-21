import type { Prisma } from "@prisma/client";
import {
  buildScopeWhere,
  enforceInTx,
  orgUnitScopeColumns,
  projectFields,
  projectRows,
  resolveScope,
  withinScope,
} from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { ORG_UNIT_FIELD_MAP, ORG_UNIT_SELECT, type OrgUnitRow } from "./fields";
import type { ListOrgUnitsQuery } from "./schemas";

type PartialUnit = Partial<OrgUnitRow>;

const activeFilter = (active: ListOrgUnitsQuery["active"]): Prisma.OrgUnitWhereInput =>
  active === "all" ? {} : { active: active === "true" };

/**
 * One page of org units the caller may see (`organization.view`), ordered by name.
 *
 * The data scope is part of the QUERY (`withinScope` + `buildScopeWhere`), never a filter applied
 * after fetching, so paging and counts cannot leak units outside the caller's scope. Each row is
 * then projected with the field sets of the scope parts that row matched (`projectRows`).
 */
export async function listOrgUnits(actor: Actor, query: ListOrgUnitsQuery): Promise<Page<PartialUnit>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "organization.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "organization.view", now);

    const callerWhere: Prisma.OrgUnitWhereInput = {
      tenantId: actor.tenantId,
      ...activeFilter(query.active),
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { code: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const rows = await tx.orgUnit.findMany({
      where: withinScope(buildScopeWhere(scope, orgUnitScopeColumns, now), callerWhere),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: ORG_UNIT_SELECT,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const projected = projectRows(page.data, scope, ORG_UNIT_FIELD_MAP, (row) => ({
      orgUnitIds: [row.id],
      legalEntityIds: row.legalEntityId ? [row.legalEntityId] : [],
    }));
    return { data: projected, page: page.page };
  });
}

/** One org unit (`organization.view` over it); outside the caller's scope it is a 404. */
export async function getOrgUnit(actor: Actor, unitId: string): Promise<PartialUnit> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "organization.view", { orgUnitId: unitId });
    const unit = await tx.orgUnit.findFirst({ where: { id: unitId, tenantId: actor.tenantId }, select: ORG_UNIT_SELECT });
    if (!unit) throw new NotFoundError();
    return projectFields(unit, decision, ORG_UNIT_FIELD_MAP);
  });
}
