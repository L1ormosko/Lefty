import type { Prisma } from "@prisma/client";
import {
  buildScopeWhere,
  canInTx,
  enforceInTx,
  fieldSetsForRow,
  resolveScope,
  withinScope,
  type AccessDecision,
  type AccessSubject,
  type ResolvedScope,
  type ResourceRef,
  type RowScopeAttributes,
  type ScopeColumns,
} from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { followUpRowSelect, targetIdOf, type FollowUpRow } from "./fields";
import { targetAccessFor, visibleTargetsWhere } from "./targets";

/**
 * How data scopes apply to follow-up tasks (§4.2, PERMISSIONS.md "Phase 3 modules") and the second gate on top of them.
 *
 *  Gate 1, the task itself (`follow_ups.*`):
 *   - `ORG_UNIT` / `LEGAL_ENTITY`: the service-area unit copied from the target when the task was created
 *     (`FollowUpTask.orgUnitId`). A task whose target has no unit is tenant-level: only a TENANT scope reaches it.
 *   - `ASSIGNED`: the caller is the task's assignee. `OWN`: the caller created it (a technician sees what they
 *     asked for and what was given to them, nothing else).
 *  Gate 2, the target: the caller must be able to view the lead / customer / job / recovery case the task is about
 *   (`targets.ts`), so a task never reveals or opens a record its reader cannot reach.
 *
 * Both gates apply to lists (one query) and to single records (`assertFollowUpAccess`); a denial is a 404.
 */

const followUpScopeColumns: ScopeColumns<Prisma.FollowUpTaskWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
  assigned: (employeeId) => ({ assigneeId: employeeId }),
  own: (employeeId) => ({ createdBy: { employee: { is: { id: employeeId } } } }),
};

/** What the scope engine needs to know about one follow-up row. */
export function followUpRowAttributes(row: FollowUpRow): RowScopeAttributes {
  const creatorEmployeeId = row.createdBy?.employee?.id ?? null;
  return {
    orgUnitIds: row.orgUnitId ? [row.orgUnitId] : [],
    legalEntityIds: row.orgUnit?.legalEntityId ? [row.orgUnit.legalEntityId] : [],
    assignedEmployeeIds: row.assigneeId ? [row.assigneeId] : [],
    ownerEmployeeId: creatorEmployeeId,
  };
}

/** The `ResourceRef` of a row. Always carries the assignee list, so a denial is a 404 and never confirms existence. */
export function followUpResourceRef(row: FollowUpRow): ResourceRef {
  const attributes = followUpRowAttributes(row);
  return {
    ...(row.orgUnitId ? { orgUnitId: row.orgUnitId } : {}),
    assignedEmployeeIds: attributes.assignedEmployeeIds,
    ...(attributes.ownerEmployeeId ? { ownerEmployeeId: attributes.ownerEmployeeId } : {}),
  };
}

export async function loadFollowUpRow(tx: TenantTx, tenantId: string, followUpId: string): Promise<FollowUpRow | null> {
  return tx.followUpTask.findFirst({ where: { id: followUpId, tenantId }, select: followUpRowSelect });
}

/** The resource reference of ONE task (route resolver); `null` when it does not exist in the tenant. Gate 2 is checked by the service. */
export async function followUpResourceRefById(tx: TenantTx, tenantId: string, followUpId: string): Promise<ResourceRef | null> {
  const row = await loadFollowUpRow(tx, tenantId, followUpId);
  return row ? followUpResourceRef(row) : null;
}

/** Locks the task row for the rest of the transaction so two status changes or assignments queue up. */
export async function lockFollowUp(tx: TenantTx, tenantId: string, followUpId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "FollowUpTask" WHERE id = ${followUpId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

/**
 * Both gates for ONE task, for `permission` (view / edit / assign). Returns the row and the decision of gate 1.
 * @throws ForbiddenError when the caller holds no grant of `permission` at all; NotFoundError for everything else
 *   (missing task, outside the task's scope, target not viewable).
 */
export async function assertFollowUpAccess(
  tx: TenantTx,
  actor: Actor,
  followUpId: string,
  permission: "follow_ups.view" | "follow_ups.edit" | "follow_ups.assign",
): Promise<{ row: FollowUpRow; decision: AccessDecision }> {
  await enforceInTx(tx, actor, permission);
  const row = await loadFollowUpRow(tx, actor.tenantId, followUpId);
  if (!row) throw new NotFoundError();
  const decision = await enforceInTx(tx, actor, permission, followUpResourceRef(row));
  await assertTargetViewable(tx, actor, row);
  return { row, decision };
}

/** Gate 2 alone: the subject must be able to view the task's target. @throws NotFoundError */
export async function assertTargetViewable(tx: TenantTx, subject: AccessSubject, row: Pick<FollowUpRow, "targetType" | "leadId" | "customerId" | "jobId" | "recoveryCaseId">): Promise<void> {
  if (!(await canViewTarget(tx, subject, row))) throw new NotFoundError();
}

export async function canViewTarget(
  tx: TenantTx,
  subject: AccessSubject,
  row: Pick<FollowUpRow, "targetType" | "leadId" | "customerId" | "jobId" | "recoveryCaseId">,
): Promise<boolean> {
  const access = targetAccessFor(row.targetType);
  const ref = await access.resourceRef(tx, subject.tenantId, targetIdOf(row));
  return ref !== null && (await canInTx(tx, subject, access.viewPermission, ref)).allowed;
}

/** Both gates as a yes / no for another user (the assignee, a notification recipient). */
export async function canAccessFollowUp(tx: TenantTx, subject: AccessSubject, row: FollowUpRow, permission = "follow_ups.view"): Promise<boolean> {
  const task = await canInTx(tx, subject, permission, followUpResourceRef(row));
  return task.allowed && (await canViewTarget(tx, subject, row));
}

export interface FollowUpListAccess {
  /** Combine with the caller's filters through `withinScope`, never by spreading. */
  where: Prisma.FollowUpTaskWhereInput;
  scope: ResolvedScope;
  fieldSetsOf: (row: FollowUpRow) => string[];
}

/** The caller's coverage for `permission`: gate 1 (scope) AND gate 2 (visible targets) as one fragment. */
export async function resolveFollowUpListAccess(tx: TenantTx, actor: Actor, permission: string, now: Date): Promise<FollowUpListAccess> {
  const scope = await resolveScope(tx, actor, permission, now);
  const taskWhere = buildScopeWhere(scope, followUpScopeColumns, now);
  const targetWhere = await visibleTargetsWhere(tx, actor, now);
  return {
    where: withinScope(taskWhere, targetWhere),
    scope,
    fieldSetsOf: (row) => fieldSetsForRow(scope, followUpRowAttributes(row)),
  };
}
