import type { Prisma } from "@prisma/client";
import {
  buildScopeWhere,
  canInTx,
  enforceInTx,
  fieldSetsForRow,
  resolveScope,
  type AccessDecision,
  type ResolvedScope,
  type ResourceRef,
  type ScopeColumns,
} from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { caseRowSelect, ruleRowSelect, type CaseRow, type RuleRow } from "./fields";

/**
 * How data scopes apply to recovery (§4.2, PERMISSIONS.md "Phase 3 modules").
 *
 * Cases: `ORG_UNIT` / `LEGAL_ENTITY` follow the service-area unit copied from the job (`LeadRecoveryCase.orgUnitId`; a case
 * without a unit is tenant-level). `ASSIGNED` / `OWN` = the recovery employee the case is assigned to.
 * Rules: `ORG_UNIT` / `LEGAL_ENTITY` follow `RecoveryRule.orgUnitId`; a tenant-wide rule (no unit) is reached only by a
 * TENANT scope. Rules have no assignee.
 * A denial for a single record is a 404 (existence of other units' cases is not revealed).
 */

export const caseScopeColumns: ScopeColumns<Prisma.LeadRecoveryCaseWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
  assigned: (employeeId) => ({ assignedToId: employeeId }),
  own: (employeeId) => ({ assignedToId: employeeId }),
};

export const ruleScopeColumns: ScopeColumns<Prisma.RecoveryRuleWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
};

export function caseResourceRef(row: Pick<CaseRow, "orgUnitId" | "assignedToId">): ResourceRef {
  return {
    ...(row.orgUnitId ? { orgUnitId: row.orgUnitId } : {}),
    assignedEmployeeIds: row.assignedToId ? [row.assignedToId] : [],
    ...(row.assignedToId ? { ownerEmployeeId: row.assignedToId } : {}),
  };
}

export const ruleResourceRef = (row: Pick<RuleRow, "orgUnitId">): ResourceRef => (row.orgUnitId ? { orgUnitId: row.orgUnitId } : {});

export const loadCaseRow = (tx: TenantTx, tenantId: string, caseId: string): Promise<CaseRow | null> =>
  tx.leadRecoveryCase.findFirst({ where: { id: caseId, tenantId }, select: caseRowSelect });

export const loadRuleRow = (tx: TenantTx, tenantId: string, ruleId: string): Promise<RuleRow | null> =>
  tx.recoveryRule.findFirst({ where: { id: ruleId, tenantId }, select: ruleRowSelect });

/** Route resolver: the scope attributes of ONE case, `null` when it does not exist in the tenant. */
export async function caseResourceRefById(tx: TenantTx, tenantId: string, caseId: string): Promise<ResourceRef | null> {
  const row = await tx.leadRecoveryCase.findFirst({ where: { id: caseId, tenantId }, select: { orgUnitId: true, assignedToId: true } });
  return row ? caseResourceRef(row) : null;
}

/** Route resolver: the scope attributes of ONE rule. */
export async function ruleResourceRefById(tx: TenantTx, tenantId: string, ruleId: string): Promise<ResourceRef | null> {
  const row = await tx.recoveryRule.findFirst({ where: { id: ruleId, tenantId }, select: { orgUnitId: true } });
  return row ? ruleResourceRef(row) : null;
}

/** @throws ForbiddenError when no grant of `permission` exists; NotFoundError for a missing or out-of-scope case. */
export async function assertCaseAccess(
  tx: TenantTx,
  actor: Actor,
  caseId: string,
  permission: "recovery.view" | "recovery.edit" | "recovery.assign",
): Promise<{ row: CaseRow; decision: AccessDecision }> {
  await enforceInTx(tx, actor, permission);
  const row = await loadCaseRow(tx, actor.tenantId, caseId);
  if (!row) throw new NotFoundError();
  const decision = await enforceInTx(tx, actor, permission, caseResourceRef(row));
  return { row, decision };
}

export async function assertRuleAccess(
  tx: TenantTx,
  actor: Actor,
  ruleId: string,
  permission: "recovery.view" | "recovery.manage" | "recovery.approve",
): Promise<RuleRow> {
  await enforceInTx(tx, actor, permission);
  const row = await loadRuleRow(tx, actor.tenantId, ruleId);
  if (!row) throw new NotFoundError();
  await enforceInTx(tx, actor, permission, ruleResourceRef(row));
  return row;
}

export interface CaseListAccess {
  where: Prisma.LeadRecoveryCaseWhereInput;
  scope: ResolvedScope;
  fieldSetsOf: (row: CaseRow) => string[];
}

export async function resolveCaseListAccess(tx: TenantTx, actor: Actor, permission: string, now: Date): Promise<CaseListAccess> {
  const scope = await resolveScope(tx, actor, permission, now);
  return {
    where: buildScopeWhere(scope, caseScopeColumns, now),
    scope,
    fieldSetsOf: (row) =>
      fieldSetsForRow(scope, {
        orgUnitIds: row.orgUnitId ? [row.orgUnitId] : [],
        legalEntityIds: row.orgUnit?.legalEntityId ? [row.orgUnit.legalEntityId] : [],
        assignedEmployeeIds: row.assignedToId ? [row.assignedToId] : [],
        ownerEmployeeId: row.assignedToId,
      }),
  };
}

/** Whether `subject` may view the case (for a notification recipient or an assignee). */
export async function canViewCase(tx: TenantTx, subject: { tenantId: string; userId: string }, caseId: string): Promise<boolean> {
  const row = await tx.leadRecoveryCase.findFirst({ where: { id: caseId, tenantId: subject.tenantId }, select: { orgUnitId: true, assignedToId: true } });
  return row ? (await canInTx(tx, subject, "recovery.view", caseResourceRef(row))).allowed : false;
}
