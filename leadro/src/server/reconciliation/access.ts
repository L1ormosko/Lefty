import type { Prisma } from "@prisma/client";
import { canInTx, enforceInTx, type AccessDecision, type ResourceRef, type ScopeColumns } from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * Who reaches which reconciliation record (docs/PERMISSIONS.md section 11, `finance_reconciliation.*`).
 *
 * - An EXCEPTION belongs to the unit recorded at detection (`orgUnitId`, the job's service-area unit then): ORG_UNIT and
 *   LEGAL_ENTITY scopes reach it through that unit. An exception without a unit (a provider event naming no job) is
 *   tenant-level: only a TENANT scope reaches it.
 * - A RUN covers a whole legal entity (or the tenant): only a TENANT scope or a LEGAL_ENTITY scope on that entity reaches
 *   it. A unit manager sees the exceptions of their units, never a legal entity's totals (same rule as
 *   `getLegalEntityBalance`).
 * - OWN / ASSIGNED scopes never match finance records (no employee columns are mapped).
 * Out of scope is always 404 (never confirms the record exists); no grant at all is 403.
 */

export const exceptionScopeColumns: ScopeColumns<Prisma.ReconciliationExceptionWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
};

/** Runs: legal entity only (a tenant-wide run, `legalEntityId` null, is reached by TENANT scopes alone). */
export const runScopeColumns: ScopeColumns<Prisma.ReconciliationRunWhereInput> = {
  legalEntity: (legalEntityIds) => ({ legalEntityId: { in: legalEntityIds } }),
};

export const exceptionRef = (exception: { orgUnitId: string | null }): ResourceRef => (exception.orgUnitId ? { orgUnitId: exception.orgUnitId } : {});
export const runRef = (run: { legalEntityId: string | null }): ResourceRef => (run.legalEntityId ? { legalEntityId: run.legalEntityId } : {});

/**
 * `enforceInTx` that answers 404 for a tenant-level record too (enforceInTx answers 403 there): an exception or run is an
 * individual record, and a 403 would confirm it exists to someone outside its scope.
 */
export async function enforceOnRecord(tx: TenantTx, actor: Actor, permission: string, ref: ResourceRef): Promise<AccessDecision> {
  await enforceInTx(tx, actor, permission); // capability: 403
  const decision = await canInTx(tx, actor, permission, ref);
  if (!decision.allowed) throw new NotFoundError();
  return decision;
}

/** Route resolver body: the exception's reference, or null (404) when it does not exist. */
export async function exceptionResourceRef(tx: TenantTx, tenantId: string, exceptionId: string): Promise<ResourceRef | null> {
  const row = await tx.reconciliationException.findFirst({ where: { id: exceptionId, tenantId }, select: { orgUnitId: true } });
  return row ? exceptionRef(row) : null;
}

/** Route resolver body: the run's reference, or null (404) when it does not exist. */
export async function runResourceRef(tx: TenantTx, tenantId: string, runId: string): Promise<ResourceRef | null> {
  const row = await tx.reconciliationRun.findFirst({ where: { id: runId, tenantId }, select: { legalEntityId: true } });
  return row ? runRef(row) : null;
}
