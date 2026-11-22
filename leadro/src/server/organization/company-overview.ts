import { enforceInTx } from "@/server/authz";
import type { Actor } from "@/server/core";
import { withTenant } from "@/server/db";

/** Company-wide figures for the Company Overview screen (§3.4). */
export interface CompanyOverview {
  /** Employees whose status is not TERMINATED. */
  activeEmployeeCount: number;
  /** Active units of type BRANCH. */
  activeBranchCount: number;
  activeLegalEntityCount: number;
  /** Names of the active STATE units, alphabetical. */
  activeStates: Array<{ id: string; name: string }>;
}

/**
 * Aggregate counts for the company overview. Needs `company_settings.view` (a tenant-level
 * record, so a TENANT-scoped grant). The numbers are tenant-wide totals by design: this screen
 * describes the whole company, and only company-level viewers can reach it, so no per-row data
 * scope or field projection applies.
 */
export async function getCompanyOverview(actor: Actor): Promise<CompanyOverview> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "company_settings.view", {});
    const tenantId = actor.tenantId;
    const [activeEmployeeCount, activeBranchCount, activeLegalEntityCount, activeStates] = await Promise.all([
      tx.employee.count({ where: { tenantId, status: { not: "TERMINATED" } } }),
      tx.orgUnit.count({ where: { tenantId, type: "BRANCH", active: true } }),
      tx.legalEntity.count({ where: { tenantId, active: true } }),
      tx.orgUnit.findMany({
        where: { tenantId, type: "STATE", active: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true },
      }),
    ]);
    return { activeEmployeeCount, activeBranchCount, activeLegalEntityCount, activeStates };
  });
}
