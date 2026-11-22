import { buildScopeWhere, canInTx, enforceInTx, resolveScope, withinScope } from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import { jobScopeColumns, leadScopeColumns } from "./assignment-access";
import { customerResourceRef } from "./customer-access";
import type { HistoryQuery } from "./schemas";

/**
 * The customer history view (§5.9 "service history", §6.1 "historical leads / jobs"): the ids,
 * numbers and statuses of the customer's leads and jobs, newest first. It needs `customers.view` over
 * the customer AND shows only the leads and jobs the caller may view in their own right:
 *  - leads: `leads.view` over the lead's scope;
 *  - jobs: `jobs.view` over the job's scope, where a grant qualified `customer_history`
 *    (Customer Relations) counts; this view is the only caller that passes that record set.
 * Money and other sensitive job fields are never selected. A grant qualified by any other record set
 * contributes nothing here (fail closed).
 *
 * Scope columns for leads and jobs are the shared ones from `assignment-access.ts`.
 */

export interface CustomerHistoryEntry {
  id: string;
  number: number;
  status: string;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface CustomerHistory {
  leads: CustomerHistoryEntry[];
  jobs: CustomerHistoryEntry[];
  /** Whether the caller holds the right to see leads / jobs at all (an empty list then means "none", not "hidden"). */
  access: { leads: boolean; jobs: boolean };
}

const entrySelect = { id: true, number: true, status: true, createdAt: true, archivedAt: true } as const;

export async function getCustomerHistory(actor: Actor, customerId: string, query: HistoryQuery): Promise<CustomerHistory> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.view");
    const ref = await customerResourceRef(tx, actor.tenantId, customerId);
    if (!ref) throw new NotFoundError();
    await enforceInTx(tx, actor, "customers.view", ref);

    const now = new Date();
    const mayViewLeads = (await canInTx(tx, actor, "leads.view")).allowed;
    const mayViewJobs = (await canInTx(tx, actor, "jobs.view")).allowed;

    let leads: CustomerHistoryEntry[] = [];
    if (mayViewLeads) {
      const scope = await resolveScope(tx, actor, "leads.view", now);
      leads = await tx.lead.findMany({
        where: withinScope(buildScopeWhere(scope, leadScopeColumns, now), { tenantId: actor.tenantId, customerId }),
        select: entrySelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit,
      });
    }

    let jobs: CustomerHistoryEntry[] = [];
    if (mayViewJobs) {
      const scope = await resolveScope(tx, actor, "jobs.view", now, { satisfiedSets: ["customer_history"] });
      jobs = await tx.job.findMany({
        where: withinScope(buildScopeWhere(scope, jobScopeColumns, now), { tenantId: actor.tenantId, customerId }),
        select: entrySelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit,
      });
    }

    return { leads, jobs, access: { leads: mayViewLeads, jobs: mayViewJobs } };
  });
}
