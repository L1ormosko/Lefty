import type { Prisma } from "@prisma/client";
import type { ResourceRef, ScopeColumns } from "@/server/authz";
import type { TenantTx } from "@/server/db";

/**
 * The facts of a job that money is posted against. `orgUnitId` / `legalEntityId` are copied onto every ledger entry at
 * posting (a snapshot: an entry is immutable, so a later move of the job does not move its money between units).
 */
export interface FinanceJob {
  id: string;
  customerId: string;
  orgUnitId: string;
  legalEntityId: string | null;
  currency: string;
}

/** Loads a job for a finance read or posting (inside the caller's tenant transaction); null when it does not exist. */
export async function loadFinanceJob(tx: TenantTx, tenantId: string, jobId: string): Promise<FinanceJob | null> {
  const job = await tx.job.findFirst({
    where: { id: jobId, tenantId },
    select: { id: true, customerId: true, orgUnitId: true, currency: true, orgUnit: { select: { legalEntityId: true } } },
  });
  if (!job) return null;
  return { id: job.id, customerId: job.customerId, orgUnitId: job.orgUnitId, legalEntityId: job.orgUnit.legalEntityId, currency: job.currency };
}

/**
 * The authorization reference for finance access to a job: its service-area unit ONLY. Deliberately no assigned employees
 * and no record sets, so OWN / ASSIGNED scopes (a technician's) never reach finance records even if a custom role carried a
 * finance permission with them; finance is reached through TENANT, LEGAL_ENTITY and ORG_UNIT scopes (docs/PERMISSIONS.md 11).
 */
export const financeJobRef = (job: Pick<FinanceJob, "orgUnitId">): ResourceRef => ({ orgUnitId: job.orgUnitId });

/** Scope columns of finance lists over jobs: unit and legal entity of the job, never ASSIGNED / OWN (see `financeJobRef`). */
export const financeJobScopeColumns: ScopeColumns<Prisma.JobWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
};

/** Scope columns of ledger entries: the unit / legal entity snapshot taken at posting. */
export const ledgerEntryScopeColumns: ScopeColumns<Prisma.LedgerEntryWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ legalEntityId: { in: legalEntityIds } }),
};
