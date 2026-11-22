import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, openEndedWhere, resolveScope, withinScope } from "@/server/authz";
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant } from "@/server/db";
import type { CreateTerritoryInput, EndGrantInput, ListByEmployeeQuery } from "./schemas";
import { endInstant } from "./grant-window";
import { assertBaseFields, territoryScopeColumns, toTerritoryView } from "./views";

/**
 * Service territories (§10.1 "geographic restrictions", §7.3 "approved service territory"): the org
 * units an employee may be dispatched into. Writing needs `qualifications.edit` over the employee
 * AND over the territory's org unit, so a manager cannot send people into units they do not manage.
 * Rows are ended, never deleted; re-adding an ended territory reopens that row (the unique key is
 * employee + unit) and the audit event keeps the earlier period.
 */

type TerritoryView = ReturnType<typeof toTerritoryView>;

export async function createTerritory(actor: Actor, ctx: RequestContext, input: CreateTerritoryInput): Promise<TerritoryView> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "qualifications.edit", { employeeId: input.employeeId });
    assertBaseFields(decision);
    await enforceInTx(tx, actor, "qualifications.edit", { orgUnitId: input.orgUnitId });

    const employee = await tx.employee.findFirst({ where: { id: input.employeeId, tenantId: actor.tenantId }, select: { status: true } });
    if (!employee) throw new NotFoundError();
    if (employee.status === "TERMINATED") throw new InvalidStateTransitionError({ message: "A terminated employee's territories cannot be changed." });
    const unit = await tx.orgUnit.findFirst({ where: { id: input.orgUnitId, tenantId: actor.tenantId }, select: { active: true } });
    if (!unit) throw new NotFoundError();
    if (!unit.active) throw new InvalidStateTransitionError({ message: "An archived unit cannot be added as a territory." });

    const now = new Date();
    const effectiveFrom = input.effectiveFrom ?? now;
    const existing = await tx.serviceTerritory.findFirst({
      where: { tenantId: actor.tenantId, employeeId: input.employeeId, orgUnitId: input.orgUnitId },
    });
    if (existing && (existing.effectiveTo === null || existing.effectiveTo.getTime() > now.getTime())) {
      throw new ConflictError({ message: "The employee already has this territory." });
    }

    const row = existing
      ? await tx.serviceTerritory.update({
          where: { id: existing.id },
          data: { includeDescendants: input.includeDescendants, effectiveFrom, effectiveTo: null },
        })
      : await tx.serviceTerritory.create({
          data: {
            tenantId: actor.tenantId,
            employeeId: input.employeeId,
            orgUnitId: input.orgUnitId,
            includeDescendants: input.includeDescendants,
            effectiveFrom,
          },
        });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "service_territory.add",
      targetType: "ServiceTerritory",
      targetId: row.id,
      previousValue: existing
        ? { effectiveFrom: existing.effectiveFrom, effectiveTo: existing.effectiveTo, includeDescendants: existing.includeDescendants }
        : undefined,
      newValue: { employeeId: input.employeeId, orgUnitId: input.orgUnitId, includeDescendants: input.includeDescendants, effectiveFrom },
    });
    return toTerritoryView(row);
  });
}

/** Ends a territory now (or cancels one that has not started). */
export async function endTerritory(actor: Actor, ctx: RequestContext, territoryId: string, input: EndGrantInput): Promise<TerritoryView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.edit");
    const row = await tx.serviceTerritory.findFirst({ where: { id: territoryId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "qualifications.edit", { employeeId: row.employeeId });
    assertBaseFields(decision);
    const now = new Date();
    if (row.effectiveTo && row.effectiveTo.getTime() <= now.getTime()) {
      throw new InvalidStateTransitionError({ message: "This territory has already ended." });
    }
    const updated = await tx.serviceTerritory.update({ where: { id: row.id }, data: { effectiveTo: endInstant(row.effectiveFrom, now) } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "service_territory.end",
      targetType: "ServiceTerritory",
      targetId: row.id,
      previousValue: { effectiveTo: row.effectiveTo },
      newValue: { effectiveTo: updated.effectiveTo },
      reason: input.reason,
    });
    return toTerritoryView(updated);
  });
}

/** One employee's territories (`qualifications.view` over them), oldest first. */
export async function listTerritories(actor: Actor, query: ListByEmployeeQuery): Promise<Page<TerritoryView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const now = new Date();
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "qualifications.view", now), "base");
    const callerWhere: Prisma.ServiceTerritoryWhereInput = {
      tenantId: actor.tenantId,
      employeeId: query.employeeId,
      ...(query.activeOnly ? { effectiveFrom: { lte: now }, ...openEndedWhere(now) } : {}),
    };
    const rows = await tx.serviceTerritory.findMany({
      where: withinScope(buildScopeWhere(scope, territoryScopeColumns, now), callerWhere),
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toTerritoryView), page: page.page };
  });
}
