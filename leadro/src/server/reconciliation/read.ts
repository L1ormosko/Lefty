import type { Prisma, ReconciliationException } from "@prisma/client";
import { RECONCILIATION_EXCEPTION_KINDS, type ReconciliationExceptionKindValue } from "@/lib/reconciliation-rules";
import { buildScopeWhere, enforceInTx, fieldSetsForRow, resolveScope, withinScope, type ResolvedScope } from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { enforceOnRecord, exceptionRef, exceptionScopeColumns, runRef, runScopeColumns } from "./access";
import type { ListExceptionsQuery, ListRunsQuery, SummaryQuery } from "./schemas";
import { toExceptionView, toRunView, type ExceptionView, type RunView } from "./views";

/** Reconciliation reads (`finance_reconciliation.view`). Scope rules: `access.ts`. */

type ExceptionRow = ReconciliationException & { orgUnit: { legalEntityId: string | null } | null };
const withUnit = { orgUnit: { select: { legalEntityId: true } } } satisfies Prisma.ReconciliationExceptionInclude;

/** Outcome money needs the `job_outcomes` `financial` set over the exception's unit (per row, never unioned across units). */
function seesOutcomeMoney(outcomeScope: ResolvedScope, row: ExceptionRow): boolean {
  const attributes = { orgUnitIds: row.orgUnitId ? [row.orgUnitId] : [], legalEntityIds: row.orgUnit?.legalEntityId ? [row.orgUnit.legalEntityId] : [] };
  return fieldSetsForRow(outcomeScope, attributes).includes("financial");
}

export async function exceptionViewsInTx(tx: TenantTx, actor: Actor, rows: ExceptionRow[]): Promise<ExceptionView[]> {
  const outcomeScope = await resolveScope(tx, actor, "job_outcomes.view");
  return rows.map((row) => toExceptionView(row, seesOutcomeMoney(outcomeScope, row)));
}

/** One page of runs the caller may see, newest first (`startedAt desc, id desc`). Unit-scoped callers see none. */
export async function listReconciliationRuns(actor: Actor, query: ListRunsQuery): Promise<Page<RunView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_reconciliation.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_reconciliation.view", now);
    const filters: Prisma.ReconciliationRunWhereInput[] = [];
    if (query.legalEntityId) filters.push({ legalEntityId: query.legalEntityId });
    if (query.currency) filters.push({ currency: query.currency });
    if (query.status) filters.push({ status: query.status });
    const rows = await tx.reconciliationRun.findMany({
      where: withinScope<Prisma.ReconciliationRunWhereInput>(buildScopeWhere(scope, runScopeColumns, now), { tenantId: actor.tenantId, AND: filters }),
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toRunView), page: page.page };
  });
}

type Counts = Record<string, number>;

export interface RunDetailView extends RunView {
  /** Exceptions this run raised (visible to the caller), by kind and by their status now. */
  raised: { total: number; byKind: Counts; byStatus: Counts };
  /** Findings of this run that were already open from an earlier run (not raised again). */
  alreadyOpen: number;
}

async function countBy(tx: TenantTx, where: Prisma.ReconciliationExceptionWhereInput, field: "kind" | "status"): Promise<Counts> {
  const grouped = await tx.reconciliationException.groupBy({ by: [field], where, _count: { _all: true } });
  return Object.fromEntries(grouped.map((row) => [row[field], row._count._all]));
}

/** One run with what it raised. */
export async function getReconciliationRun(actor: Actor, runId: string): Promise<RunDetailView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_reconciliation.view");
    const run = await tx.reconciliationRun.findFirst({ where: { id: runId, tenantId: actor.tenantId } });
    if (!run) throw new NotFoundError();
    await enforceOnRecord(tx, actor, "finance_reconciliation.view", runRef(run));
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_reconciliation.view", now);
    const where = withinScope<Prisma.ReconciliationExceptionWhereInput>(buildScopeWhere(scope, exceptionScopeColumns, now), { tenantId: actor.tenantId, runId: run.id });
    const byKind = await countBy(tx, where, "kind");
    const total = Object.values(byKind).reduce((sum, count) => sum + count, 0);
    return {
      ...toRunView(run),
      raised: { total, byKind, byStatus: await countBy(tx, where, "status") },
      alreadyOpen: run.status === "COMPLETED" ? Math.max(run.exceptionCount - (await tx.reconciliationException.count({ where: { tenantId: actor.tenantId, runId: run.id } })), 0) : 0,
    };
  });
}

/**
 * One page of exceptions in the caller's scope, newest first (`createdAt desc, id desc`). `assignedToId=me` is the
 * caller's own queue; `state=unresolved` the open work (OPEN or ASSIGNED).
 */
export async function listReconciliationExceptions(actor: Actor, query: ListExceptionsQuery): Promise<Page<ExceptionView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_reconciliation.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_reconciliation.view", now);
    const filters: Prisma.ReconciliationExceptionWhereInput[] = [];
    if (query.runId) filters.push({ runId: query.runId });
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.kind) filters.push({ kind: query.kind });
    if (query.currency) filters.push({ currency: query.currency });
    if (query.status) filters.push({ status: query.status });
    else if (query.state === "unresolved") filters.push({ status: { in: ["OPEN", "ASSIGNED"] } });
    if (query.assignedToId) filters.push({ assignedToId: query.assignedToId === "me" ? actor.userId : query.assignedToId });
    const rows = await tx.reconciliationException.findMany({
      where: withinScope<Prisma.ReconciliationExceptionWhereInput>(buildScopeWhere(scope, exceptionScopeColumns, now), { tenantId: actor.tenantId, AND: filters }),
      include: withUnit,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: await exceptionViewsInTx(tx, actor, page.data), page: page.page };
  });
}

/** Loads one exception for a read or a workflow step (404 when missing or outside the caller's scope for `permission`). */
export async function loadExceptionInTx(tx: TenantTx, actor: Actor, exceptionId: string, permission: string): Promise<ExceptionRow> {
  await enforceInTx(tx, actor, permission);
  const row = await tx.reconciliationException.findFirst({ where: { id: exceptionId, tenantId: actor.tenantId }, include: withUnit });
  if (!row) throw new NotFoundError();
  await enforceOnRecord(tx, actor, permission, exceptionRef(row));
  return row;
}

export async function getReconciliationException(actor: Actor, exceptionId: string): Promise<ExceptionView> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await loadExceptionInTx(tx, actor, exceptionId, "finance_reconciliation.view");
    const [view] = await exceptionViewsInTx(tx, actor, [row]);
    return view;
  });
}

export interface ReconciliationSummaryView {
  /** TENANT: every exception was counted. SCOPE: only those in the caller's units / legal entities. */
  coverage: "TENANT" | "SCOPE";
  /** Unresolved exceptions (OPEN, ASSIGNED) per kind; every kind is listed, zero included. */
  unresolved: Record<ReconciliationExceptionKindValue, { open: number; assigned: number }>;
  unresolvedTotal: number;
  oldestUnresolvedAt: Date | null;
  /** The latest COMPLETED run per legal entity and currency the caller may see (unit-scoped callers: none). */
  latestRuns: RunView[];
}

/** The reconciliation work queue at a glance. Counts only: no amounts, so no outcome money to redact. */
export async function getReconciliationSummary(actor: Actor, query: SummaryQuery): Promise<ReconciliationSummaryView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_reconciliation.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_reconciliation.view", now);
    const filters: Prisma.ReconciliationExceptionWhereInput[] = [{ status: { in: ["OPEN", "ASSIGNED"] } }];
    if (query.currency) filters.push({ currency: query.currency });
    if (query.legalEntityId) filters.push({ orgUnit: { legalEntityId: query.legalEntityId } });
    const where = withinScope<Prisma.ReconciliationExceptionWhereInput>(buildScopeWhere(scope, exceptionScopeColumns, now), { tenantId: actor.tenantId, AND: filters });

    const grouped = await tx.reconciliationException.groupBy({ by: ["kind", "status"], where, _count: { _all: true }, _min: { createdAt: true } });
    const unresolved = Object.fromEntries(RECONCILIATION_EXCEPTION_KINDS.map((kind) => [kind, { open: 0, assigned: 0 }])) as ReconciliationSummaryView["unresolved"];
    let oldestUnresolvedAt: Date | null = null;
    for (const row of grouped) {
      unresolved[row.kind][row.status === "ASSIGNED" ? "assigned" : "open"] += row._count._all;
      const oldest = row._min.createdAt;
      if (oldest && (!oldestUnresolvedAt || oldest < oldestUnresolvedAt)) oldestUnresolvedAt = oldest;
    }

    const runFilters: Prisma.ReconciliationRunWhereInput[] = [{ status: "COMPLETED" }];
    if (query.currency) runFilters.push({ currency: query.currency });
    if (query.legalEntityId) runFilters.push({ legalEntityId: query.legalEntityId });
    const runs = await tx.reconciliationRun.findMany({
      where: withinScope<Prisma.ReconciliationRunWhereInput>(buildScopeWhere(scope, runScopeColumns, now), { tenantId: actor.tenantId, AND: runFilters }),
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    const latest = new Map<string, RunView>();
    for (const run of runs) {
      const key = `${run.legalEntityId ?? ""}|${run.currency}`;
      if (!latest.has(key)) latest.set(key, toRunView(run));
    }

    return {
      coverage: scope.tenantWide ? "TENANT" : "SCOPE",
      unresolved,
      unresolvedTotal: grouped.reduce((sum, row) => sum + row._count._all, 0),
      oldestUnresolvedAt,
      latestRuns: [...latest.values()],
    };
  });
}
