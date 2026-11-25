import type { ResourceRef } from "@/server/authz";
import type { TenantTx } from "@/server/db";
import { ledgerEntryRef } from "./entries";
import { financeJobRef, loadFinanceJob } from "./job-ref";

/**
 * Authorization references for the finance routes' `requirePermission` resolvers (null = the record does not exist, which
 * the route answers 404 exactly like an out-of-scope record). Finance reaches a job through its unit only.
 */

/** A job. */
export async function financeJobRefById(tx: TenantTx, tenantId: string, jobId: string): Promise<ResourceRef | null> {
  const job = await loadFinanceJob(tx, tenantId, jobId);
  return job ? financeJobRef(job) : null;
}

/** An outcome, through its job (read model over `JobOutcome`). */
export async function outcomeFinanceRef(tx: TenantTx, tenantId: string, outcomeId: string): Promise<ResourceRef | null> {
  const outcome = await tx.jobOutcome.findFirst({ where: { id: outcomeId, tenantId }, select: { job: { select: { orgUnitId: true } } } });
  return outcome ? financeJobRef(outcome.job) : null;
}

/** A ledger entry, by its unit / legal entity snapshot (reads). */
export async function ledgerEntryRefById(tx: TenantTx, tenantId: string, entryId: string): Promise<ResourceRef | null> {
  const entry = await tx.ledgerEntry.findFirst({ where: { id: entryId, tenantId }, select: { orgUnitId: true, legalEntityId: true } });
  return entry ? ledgerEntryRef(entry) : null;
}

/** A ledger entry, by its job's current unit (corrections follow the job, like voiding a payment). */
export async function ledgerEntryJobRef(tx: TenantTx, tenantId: string, entryId: string): Promise<ResourceRef | null> {
  const entry = await tx.ledgerEntry.findFirst({ where: { id: entryId, tenantId }, select: { job: { select: { orgUnitId: true } } } });
  return entry?.job ? financeJobRef(entry.job) : null;
}
