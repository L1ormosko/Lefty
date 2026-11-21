import type { Prisma } from "@prisma/client";
import { buildScopeWhere, enforceInTx, orgUnitScopeColumns, resolveScope, withinScope } from "@/server/authz";
import { pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";

/** The audit actions that describe a change to the structure itself. */
const UNIT_CHANGE_ACTIONS = [
  "org_unit.create",
  "org_unit.update",
  "org_unit.move",
  "org_unit.archive",
  "org_unit.manager_assign",
  "org_unit.manager_unassign",
] as const;

/** One structural change of an org unit, shaped for the Organization History screen. */
export interface UnitChangeEntry {
  id: string;
  occurredAt: Date;
  action: string;
  orgUnitId: string;
  orgUnitName: string | null;
  /** Names of the parent before / after, for `org_unit.move` (null = top level / not applicable). */
  previousParentName: string | null;
  newParentName: string | null;
  /** Display name of the user responsible (their employee name, else their login email). */
  recordedBy: string | null;
  reason: string | null;
  /** Field names that changed, for `org_unit.update`. */
  changedFields: string[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Structural changes of the org units the caller may see (`organization.view`), newest first, from
 * the append-only audit trail: creations, renames/edits, moves (previous and new parent), archives
 * and manager changes, each with who did it and why. The unit scope is part of the query (units
 * outside the caller's scope never appear); an optional `orgUnitId` narrows to one unit and is a
 * 404 when that unit is outside scope. This reads the audit table through a unit-scoped filter so
 * a manager does not need the tenant-wide `audit.view` to see the history of their own branch.
 */
export async function listUnitChanges(
  actor: Actor,
  query: { cursor?: string; limit: number; orgUnitId?: string },
): Promise<Page<UnitChangeEntry>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "organization.view", query.orgUnitId ? { orgUnitId: query.orgUnitId } : undefined);
    const now = new Date();
    const scope = await resolveScope(tx, actor, "organization.view", now);

    const where: Prisma.AuditEventWhereInput = {
      tenantId: actor.tenantId,
      targetType: "OrgUnit",
      action: { in: [...UNIT_CHANGE_ACTIONS] },
      ...(query.orgUnitId ? { targetId: query.orgUnitId } : {}),
    };
    if (!scope.tenantWide) {
      const visible = await tx.orgUnit.findMany({
        where: withinScope(buildScopeWhere(scope, orgUnitScopeColumns, now), { tenantId: actor.tenantId }),
        select: { id: true },
      });
      where.targetId = query.orgUnitId
        ? { in: visible.map((unit) => unit.id).filter((id) => id === query.orgUnitId) }
        : { in: visible.map((unit) => unit.id) };
    }

    const rows = await tx.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { id: true, occurredAt: true, action: true, targetId: true, actorUserId: true, previousValue: true, newValue: true, reason: true },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);

    const parentIds = new Set<string>();
    for (const row of page.data) {
      for (const value of [asRecord(row.previousValue), asRecord(row.newValue)]) {
        if (typeof value.parentId === "string") parentIds.add(value.parentId);
      }
    }
    const unitIds = [...new Set([...parentIds, ...page.data.map((row) => row.targetId).filter((id): id is string => id !== null)])];
    const units = await tx.orgUnit.findMany({ where: { tenantId: actor.tenantId, id: { in: unitIds } }, select: { id: true, name: true } });
    const unitName = new Map(units.map((unit) => [unit.id, unit.name]));

    const actorIds = [...new Set(page.data.map((row) => row.actorUserId).filter((id): id is string => id !== null))];
    const users = await tx.user.findMany({
      where: { tenantId: actor.tenantId, id: { in: actorIds } },
      select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } },
    });
    const userName = new Map(users.map((user) => [user.id, user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : user.email]));

    const parentName = (parentId: unknown) => (typeof parentId === "string" ? (unitName.get(parentId) ?? null) : null);
    return {
      data: page.data.map((row) => {
        const previous = asRecord(row.previousValue);
        const next = asRecord(row.newValue);
        return {
          id: row.id,
          occurredAt: row.occurredAt,
          action: row.action,
          orgUnitId: row.targetId ?? "",
          orgUnitName: row.targetId ? (unitName.get(row.targetId) ?? null) : null,
          previousParentName: parentName(previous.parentId),
          newParentName: parentName(next.parentId),
          recordedBy: row.actorUserId ? (userName.get(row.actorUserId) ?? null) : null,
          reason: row.reason,
          changedFields: row.action === "org_unit.update" ? Object.keys(next) : [],
        };
      }),
      page: page.page,
    };
  });
}
