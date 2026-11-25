import type { Prisma } from "@prisma/client";
import { summarizeLedger, type EffectiveLedgerType, type LedgerAmount, type LedgerBalance } from "@/lib/ledger-balances";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope } from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { financeJobRef, financeJobScopeColumns, ledgerEntryScopeColumns, loadFinanceJob } from "./job-ref";
import type { BalanceQuery, JobBalancesQuery } from "./schemas";

/**
 * Derived balances (spec 11.8: never stored). Every number here is a sum over `LedgerEntry` rows at read time, through
 * `summarizeLedger` (src/lib/ledger-balances.ts). Permission: `finance_ledger.view`.
 *
 * Scope: a JOB balance is authorized by the job's CURRENT unit and covers all of the job's entries; customer and legal
 * entity balances and lists sum only the entries inside the caller's scope, judged by the unit / legal entity snapshot
 * each entry took at posting.
 */

const occurredWhere = (query: BalanceQuery): Prisma.LedgerEntryWhereInput[] => [
  ...(query.occurredFrom ? [{ occurredAt: { gte: query.occurredFrom } }] : []),
  ...(query.occurredTo ? [{ occurredAt: { lt: query.occurredTo } }] : []),
];

/**
 * The amounts of the entries matching `where`, ready for `summarizeLedger`: non-reversal entries grouped by currency and
 * type in the database; reversals one by one with the type they reverse (rare, so a plain read is fine).
 */
export async function ledgerAmountsInTx(tx: TenantTx, where: Prisma.LedgerEntryWhereInput): Promise<LedgerAmount[]> {
  const grouped = await tx.ledgerEntry.groupBy({
    by: ["currency", "type"],
    where: withinScope<Prisma.LedgerEntryWhereInput>(where, { type: { not: "REVERSAL" } }),
    _sum: { amountMinor: true },
  });
  const reversals = await tx.ledgerEntry.findMany({
    where: withinScope<Prisma.LedgerEntryWhereInput>(where, { type: "REVERSAL" }),
    select: { currency: true, amountMinor: true, reverses: { select: { type: true } } },
  });
  return [
    ...grouped.map((row) => ({ currency: row.currency, effectiveType: row.type as EffectiveLedgerType, amountMinor: row._sum.amountMinor ?? 0n })),
    // `reverses` is always set on a REVERSAL (DB CHECK ledger_entry_reversal_link) and never another REVERSAL (trigger).
    ...reversals.flatMap((row) => (row.reverses ? [{ currency: row.currency, effectiveType: row.reverses.type as EffectiveLedgerType, amountMinor: row.amountMinor }] : [])),
  ];
}

/** Balances of one job (all of its entries), for other finance modules inside their own transaction. No permission check. */
export async function jobBalanceInTx(tx: TenantTx, tenantId: string, jobId: string): Promise<LedgerBalance[]> {
  return summarizeLedger(await ledgerAmountsInTx(tx, { tenantId, jobId }));
}

export interface JobBalanceView {
  jobId: string;
  customerId: string;
  /** One balance and payment status per currency (normally just the job's). Empty = nothing posted. */
  balances: LedgerBalance[];
}

/** Charged / collected / refunded / outstanding and the payment status of one job (`finance_ledger.view` over the job). */
export async function getJobBalance(actor: Actor, jobId: string): Promise<JobBalanceView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_ledger.view");
    const job = await loadFinanceJob(tx, actor.tenantId, jobId);
    if (!job) throw new NotFoundError();
    await enforceInTx(tx, actor, "finance_ledger.view", financeJobRef(job));
    return { jobId: job.id, customerId: job.customerId, balances: await jobBalanceInTx(tx, actor.tenantId, job.id) };
  });
}

export interface ScopedBalanceView {
  /** TENANT: every entry was summed. SCOPE: only the entries inside the caller's units / legal entities. */
  coverage: "TENANT" | "SCOPE";
  balances: LedgerBalance[];
}

/**
 * A customer's balances over the entries the caller may see. A caller without a tenant-wide grant who sees no entry of
 * the customer gets 404, so the endpoint never confirms that a customer exists outside their scope.
 */
export async function getCustomerBalance(actor: Actor, customerId: string, query: BalanceQuery): Promise<ScopedBalanceView & { customerId: string }> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_ledger.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_ledger.view", now);
    const where = withinScope<Prisma.LedgerEntryWhereInput>(buildScopeWhere(scope, ledgerEntryScopeColumns, now), {
      tenantId: actor.tenantId,
      customerId,
      AND: occurredWhere(query),
    });
    if (scope.tenantWide) {
      const exists = await tx.customer.findFirst({ where: { id: customerId, tenantId: actor.tenantId }, select: { id: true } });
      if (!exists) throw new NotFoundError();
    } else if ((await tx.ledgerEntry.count({ where: withinScope(buildScopeWhere(scope, ledgerEntryScopeColumns, now), { tenantId: actor.tenantId, customerId }) })) === 0) {
      throw new NotFoundError();
    }
    return { customerId, coverage: scope.tenantWide ? "TENANT" : "SCOPE", balances: summarizeLedger(await ledgerAmountsInTx(tx, where)) };
  });
}

/**
 * A legal entity's balances (entries whose legal-entity snapshot is it). Needs `finance_ledger.view` with a TENANT scope
 * or a LEGAL_ENTITY scope on that entity: a unit-scoped manager does not see a whole legal entity's totals.
 */
export async function getLegalEntityBalance(actor: Actor, legalEntityId: string, query: BalanceQuery): Promise<{ legalEntityId: string; balances: LedgerBalance[] }> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_ledger.view");
    // `{ legalEntityId }` resolves to the entity only (no unit), so ORG_UNIT scopes cannot match it; a missing id is 404.
    await enforceInTx(tx, actor, "finance_ledger.view", { legalEntityId });
    const where: Prisma.LedgerEntryWhereInput = { tenantId: actor.tenantId, legalEntityId, AND: occurredWhere(query) };
    return { legalEntityId, balances: summarizeLedger(await ledgerAmountsInTx(tx, where)) };
  });
}

/**
 * One page of jobs that have ledger entries, with their balances, newest job first (`createdAt desc, id desc`). The data
 * scope is in the query (the job's current unit / legal entity); balances cover each listed job's entries.
 */
export async function listJobBalances(actor: Actor, query: JobBalancesQuery): Promise<Page<JobBalanceView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_ledger.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_ledger.view", now);
    const jobs = await tx.job.findMany({
      where: withinScope<Prisma.JobWhereInput>(buildScopeWhere(scope, financeJobScopeColumns, now), {
        tenantId: actor.tenantId,
        ledgerEntries: { some: {} },
        ...(query.customerId ? { customerId: query.customerId } : {}),
      }),
      select: { id: true, customerId: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(jobs, query.limit);
    const data: JobBalanceView[] = [];
    for (const job of page.data) {
      data.push({ jobId: job.id, customerId: job.customerId, balances: await jobBalanceInTx(tx, actor.tenantId, job.id) });
    }
    return { data, page: page.page };
  });
}
