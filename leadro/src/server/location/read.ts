import type { Prisma } from "@prisma/client";
import { buildScopeWhere, enforceInTx, fieldSetsForRow, LOCATION_EVENT_FIELD_MAP, projectFields, resolveScope, withinScope } from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import type { ListLocationEventsQuery } from "./schemas";
import { locationEventAttributes, locationEventScopeColumns, locationEventSelect, locationEventView } from "./views";

/**
 * History reads (spec 17, 22.2). Both need `location.view` (a SENSITIVE permission: technicians and dispatchers do not
 * hold it). A plain grant returns when / what / how accurate / what the server concluded; raw latitude and longitude need
 * the opt-in `coordinates` field set and are projected away per row otherwise. Out-of-scope events are 404.
 */

/** One page of location events the caller may see, newest first (`serverTime desc, id desc`). Scope is part of the query. */
export async function listLocationEvents(actor: Actor, query: ListLocationEventsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "location.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "location.view", now);

    const filters: Prisma.LocationEventWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.shiftId ? { shiftId: query.shiftId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.from || query.to ? { serverTime: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } } : {}),
    };
    const rows = await tx.locationEvent.findMany({
      where: withinScope(buildScopeWhere(scope, locationEventScopeColumns, now), filters),
      select: locationEventSelect,
      orderBy: [{ serverTime: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data = page.data.flatMap((row) => {
      const fieldSets = fieldSetsForRow(scope, locationEventAttributes(row));
      // Filters match base columns: a row seen only through a coordinates-only grant must not be findable by them.
      if (!fieldSets.includes("base")) return [];
      return [projectFields(locationEventView(row), { allowed: true, fieldSets }, LOCATION_EVENT_FIELD_MAP)];
    });
    return { data, page: page.page };
  });
}

/** One location event (`location.view` over its unit / employee), projected to the caller's grant. */
export async function getLocationEvent(actor: Actor, eventId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "location.view");
    const row = await tx.locationEvent.findFirst({ where: { id: eventId, tenantId: actor.tenantId }, select: locationEventSelect });
    if (!row) throw new NotFoundError();
    const attributes = locationEventAttributes(row);
    const decision = await enforceInTx(tx, actor, "location.view", {
      orgUnitId: row.orgUnitId ?? undefined,
      legalEntityId: row.employee.legalEntityId ?? undefined,
      ownerEmployeeId: attributes.ownerEmployeeId ?? undefined,
    });
    if (!decision.fieldSets.includes("base")) throw new NotFoundError();
    return projectFields(locationEventView(row), decision, LOCATION_EVENT_FIELD_MAP);
  });
}
