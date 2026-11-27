import type { Prisma } from "@prisma/client";
import type { KpiFact } from "@/lib/kpi-aggregation";
import type { EffectiveLedgerType } from "@/lib/ledger-balances";
import { MAX_SOURCE_ROWS, assertWithinRowCap, rangeOf, type KpiComputeContext, type KpiFactLoader } from "./compute-context";

/**
 * Fact loaders of the financial KPIs (spec 13.1, 13.3). The ledger is the source of truth (Phase 4): every money KPI except sold
 * revenue is a signed sum of `LedgerEntry` amounts, one fact per entry, with a REVERSAL counted under the type it reverses (the
 * rule of `src/lib/ledger-balances.ts`). Sold revenue is the approved amount the technician reported on SOLD outcomes, before
 * finance confirms anything. Formulas are the catalog's (`src/lib/kpi-catalog.ts`); a change here must change the catalog text.
 */

const take = MAX_SOURCE_ROWS + 1;

/** How much ONE entry of an effective type adds to a KPI; a type missing from the map does not count. */
type Contribution = Partial<Record<EffectiveLedgerType, (amountMinor: bigint) => bigint>>;

const asIs = (amount: bigint) => amount;
const negated = (amount: bigint) => -amount;

/** REFUND, CHARGEBACK and MATERIAL_COST are stored negative (DB CHECK); their KPIs report positive amounts. */
const CONTRIBUTIONS: Record<string, Contribution> = {
  charged_revenue: { CHARGE: asIs },
  collected_revenue: { PAYMENT: asIs },
  refunds: { REFUND: negated },
  chargebacks: { CHARGEBACK: negated },
  adjustments: { ADJUSTMENT: asIs },
  material_costs: { MATERIAL_COST: negated },
  direct_costs: { MATERIAL_COST: negated },
  gross_profit: { CHARGE: asIs, MATERIAL_COST: asIs },
  // Billed (charges + adjustments) minus net collected (payments - refunds - chargebacks), signs as stored.
  outstanding_amount: { CHARGE: asIs, ADJUSTMENT: asIs, PAYMENT: negated, REFUND: negated, CHARGEBACK: negated },
};

/** Entries of the given effective types (reversals included) in the viewer's scope, inside the range unless `snapshot`. */
async function ledgerEntries(context: KpiComputeContext, types: EffectiveLedgerType[], snapshot: boolean) {
  return assertWithinRowCap(
    await context.tx.ledgerEntry.findMany({
      where: context.where<Prisma.LedgerEntryWhereInput>({
        tenantId: context.tenantId,
        ...(snapshot ? {} : { occurredAt: rangeOf(context) }),
        OR: [{ type: { in: types } }, { type: "REVERSAL", reverses: { type: { in: types } } }],
      }),
      select: { id: true, type: true, amountMinor: true, currency: true, orgUnitId: true, occurredAt: true, reverses: { select: { type: true } } },
      orderBy: { id: "asc" },
      take,
    }),
  );
}

function ledgerLoader(key: string, snapshot = false): KpiFactLoader {
  const contribution = CONTRIBUTIONS[key];
  const types = Object.keys(contribution) as EffectiveLedgerType[];
  return async (context) =>
    (await ledgerEntries(context, types, snapshot)).flatMap((entry): KpiFact[] => {
      // `reverses` is always set on a REVERSAL (DB CHECK ledger_entry_reversal_link) and never another REVERSAL (trigger).
      const effective = (entry.type === "REVERSAL" ? entry.reverses?.type : entry.type) as EffectiveLedgerType | undefined;
      const contribute = effective ? contribution[effective] : undefined;
      if (!contribute) return [];
      return [
        {
          recordId: entry.id,
          at: snapshot ? context.now : entry.occurredAt,
          orgUnitId: entry.orgUnitId,
          currency: entry.currency,
          amountMinor: contribute(entry.amountMinor),
        },
      ];
    });
}

/** Approved amounts of SOLD visits in the range, attributed to the job's unit (outcomes carry none of their own). */
const soldRevenue: KpiFactLoader = async (context) =>
  assertWithinRowCap(
    await context.tx.jobOutcome.findMany({
      where: {
        tenantId: context.tenantId,
        outcome: "SOLD",
        approvedAmountMinor: { not: null },
        occurredAt: rangeOf(context),
        job: context.where<Prisma.JobWhereInput>({ tenantId: context.tenantId }),
      },
      select: { id: true, occurredAt: true, approvedAmountMinor: true, currency: true, job: { select: { orgUnitId: true } } },
      orderBy: { id: "asc" },
      take,
    }),
  ).map((outcome) => ({
    recordId: outcome.id,
    at: outcome.occurredAt,
    orgUnitId: outcome.job.orgUnitId,
    currency: outcome.currency,
    amountMinor: outcome.approvedAmountMinor as bigint, // filtered on not null
  }));

/** Exceptions waiting for a person right now. */
const exceptionsOpen: KpiFactLoader = async (context) =>
  assertWithinRowCap(
    await context.tx.reconciliationException.findMany({
      where: context.where<Prisma.ReconciliationExceptionWhereInput>({ tenantId: context.tenantId, status: { in: ["OPEN", "ASSIGNED"] } }),
      select: { id: true, orgUnitId: true },
      orderBy: { id: "asc" },
      take,
    }),
  ).map((exception) => ({ recordId: exception.id, at: context.now, orgUnitId: exception.orgUnitId }));

const exceptionsResolved: KpiFactLoader = async (context) =>
  assertWithinRowCap(
    await context.tx.reconciliationException.findMany({
      where: context.where<Prisma.ReconciliationExceptionWhereInput>({ tenantId: context.tenantId, status: "RESOLVED", resolvedAt: rangeOf(context) }),
      select: { id: true, orgUnitId: true, resolvedAt: true },
      orderBy: { id: "asc" },
      take,
    }),
  ).map((exception) => ({ recordId: exception.id, at: exception.resolvedAt as Date, orgUnitId: exception.orgUnitId }));

export const FINANCIAL_LOADERS: Record<string, KpiFactLoader> = {
  sold_revenue: soldRevenue,
  charged_revenue: ledgerLoader("charged_revenue"),
  collected_revenue: ledgerLoader("collected_revenue"),
  outstanding_amount: ledgerLoader("outstanding_amount", true),
  material_costs: ledgerLoader("material_costs"),
  direct_costs: ledgerLoader("direct_costs"),
  gross_profit: ledgerLoader("gross_profit"),
  refunds: ledgerLoader("refunds"),
  adjustments: ledgerLoader("adjustments"),
  chargebacks: ledgerLoader("chargebacks"),
  reconciliation_exceptions_open: exceptionsOpen,
  reconciliation_exceptions_resolved: exceptionsResolved,
};
