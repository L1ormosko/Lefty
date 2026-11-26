import type { LedgerEntry, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope, type ResourceRef } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { financeJobRef, ledgerEntryScopeColumns, loadFinanceJob } from "./job-ref";
import { publishLedgerCorrection } from "./correction-events";
import { ledgerKeys } from "./keys";
import { reverseLedgerEntryInTx } from "./post";
import type { ListLedgerQuery, ReverseEntryInput } from "./schemas";

/**
 * Reading ledger entries (`finance_ledger.view`, scoped by each entry's unit / legal entity snapshot) and reversing a
 * CHARGE (`finance_payments.edit` over the job: the same permission that voids a payment, since both correct recorded
 * money). Entries are never edited; the response of a reversed entry names the reversal.
 */

export interface LedgerEntryView extends Omit<LedgerEntry, "tenantId"> {
  /** The REVERSAL that cancels this entry, if any. */
  reversedByEntryId: string | null;
}

const entryInclude = { reversedBy: { select: { id: true } } } satisfies Prisma.LedgerEntryInclude;

function toView(row: LedgerEntry & { reversedBy: Array<{ id: string }> }): LedgerEntryView {
  const { tenantId: _tenantId, reversedBy, ...entry } = row;
  return { ...entry, reversedByEntryId: reversedBy[0]?.id ?? null };
}

/** The authorization reference of one entry: its snapshot unit and legal entity (an entry with neither is tenant-level). */
export function ledgerEntryRef(entry: Pick<LedgerEntry, "orgUnitId" | "legalEntityId">): ResourceRef {
  return {
    ...(entry.orgUnitId ? { orgUnitId: entry.orgUnitId } : {}),
    ...(entry.legalEntityId ? { legalEntityId: entry.legalEntityId } : {}),
  };
}

/** One page of entries the caller may see, newest first (`occurredAt desc, id desc`). */
export async function listLedgerEntries(actor: Actor, query: ListLedgerQuery): Promise<Page<LedgerEntryView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_ledger.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_ledger.view", now);
    const filters: Prisma.LedgerEntryWhereInput[] = [];
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.customerId) filters.push({ customerId: query.customerId });
    if (query.outcomeId) filters.push({ outcomeId: query.outcomeId });
    if (query.paymentId) filters.push({ paymentId: query.paymentId });
    if (query.legalEntityId) filters.push({ legalEntityId: query.legalEntityId });
    if (query.type) filters.push({ type: query.type });
    if (query.occurredFrom) filters.push({ occurredAt: { gte: query.occurredFrom } });
    if (query.occurredTo) filters.push({ occurredAt: { lt: query.occurredTo } });
    const rows = await tx.ledgerEntry.findMany({
      where: withinScope<Prisma.LedgerEntryWhereInput>(buildScopeWhere(scope, ledgerEntryScopeColumns, now), { tenantId: actor.tenantId, AND: filters }),
      include: entryInclude,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toView), page: page.page };
  });
}

/** One entry (`finance_ledger.view` over its snapshot unit / legal entity; outside the scope = 404). */
export async function getLedgerEntry(actor: Actor, entryId: string): Promise<LedgerEntryView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_ledger.view");
    const row = await tx.ledgerEntry.findFirst({ where: { id: entryId, tenantId: actor.tenantId }, include: entryInclude });
    if (!row) throw new NotFoundError();
    // Every posting path sets a job, so an entry has a unit; one without would be tenant-level (TENANT scope only).
    await enforceInTx(tx, actor, "finance_ledger.view", ledgerEntryRef(row));
    return toView(row);
  });
}

/**
 * Reverses a CHARGE (spec 11.8: corrections only by reversal). Payments are corrected by voiding the payment, refunds,
 * chargebacks and adjustments by their own flows (Task 5): those entries must stay consistent with their records, so
 * they are refused here. Idempotent: reversing the same charge again returns the existing reversal.
 */
export async function reverseCharge(actor: Actor, ctx: RequestContext, entryId: string, input: ReverseEntryInput): Promise<{ reversal: LedgerEntryView; replayed: boolean }> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_payments.edit");
    const entry = await tx.ledgerEntry.findFirst({ where: { id: entryId, tenantId: actor.tenantId } });
    if (!entry || !entry.jobId) throw new NotFoundError();
    const job = await loadFinanceJob(tx, actor.tenantId, entry.jobId);
    if (!job) throw new NotFoundError();
    await enforceInTx(tx, actor, "finance_payments.edit", financeJobRef(job));
    if (entry.type !== "CHARGE") {
      throw new InvalidStateTransitionError({
        message: "Only a charge is reversed here; void the payment or use the refund, chargeback or adjustment flow instead.",
        details: [{ field: "entryId", code: "ledger.reverse_not_supported", message: "Only a charge is reversed here." }],
      });
    }

    const { entry: reversal, replayed } = await reverseLedgerEntryInTx(tx, {
      tenantId: actor.tenantId,
      entryId: entry.id,
      actor: { userId: actor.userId },
      reason: input.reason,
      idempotencyKey: ledgerKeys.reversal(entry.id),
    });
    if (!replayed) {
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "ledger.reverse",
        targetType: "LedgerEntry",
        targetId: entry.id,
        newValue: { reversalEntryId: reversal.id, type: entry.type, amountMinor: reversal.amountMinor.toString(), currency: reversal.currency, jobId: entry.jobId, outcomeId: entry.outcomeId },
        reason: input.reason,
      });
      // No approval stands behind a charge reversal: subscribers (finance review flags) make a second person see it.
      await publishLedgerCorrection(tx, {
        tenantId: actor.tenantId,
        kind: "CHARGE_REVERSED",
        jobId: job.id,
        customerId: job.customerId,
        orgUnitId: job.orgUnitId,
        originalEntryId: entry.id,
        reversalEntryId: reversal.id,
        paymentId: entry.paymentId,
        outcomeId: entry.outcomeId,
        amountMinor: entry.amountMinor,
        currency: entry.currency,
        actorUserId: actor.userId,
      });
    }
    const row =await tx.ledgerEntry.findFirstOrThrow({ where: { id: reversal.id, tenantId: actor.tenantId }, include: entryInclude });
    return { reversal: toView(row), replayed };
  });
}
