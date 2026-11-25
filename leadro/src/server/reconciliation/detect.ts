import type { Prisma } from "@prisma/client";
import { summarizeLedger, type EffectiveLedgerType, type LedgerBalance } from "@/lib/ledger-balances";
import {
  classifyJobBalance,
  classifyOutcomeCharge,
  classifyRefund,
  type ReconciliationFinding,
} from "@/lib/reconciliation-rules";
import type { TenantTx } from "@/server/db";

/**
 * Exception detection for one run (spec 5.7, 13.3, 25.4). Reads only: it gathers the facts of the period and asks
 * `src/lib/reconciliation-rules.ts` what they mean. No permission check (the run service checked `finance_reconciliation.create`).
 *
 * Which records a run looks at (`[periodStart, periodEnd)`, one currency, one legal entity or the whole tenant):
 * - jobs with ledger activity in the period (`occurredAt`; the entry's legal-entity SNAPSHOT decides the entity; material
 *   cost entries do not count as money activity), with a SOLD outcome in the period, a payment created / received /
 *   failed / voided in the period, or a refund requested / posted in the period (the job's CURRENT unit decides the
 *   entity for those, they have no snapshot);
 * - for each such job, expected (billed) vs recorded (net collected) over ALL of its entries in the currency, as the
 *   ledger knows them now: the period picks the jobs, the run reports their current state (an exception is work to do);
 * - failed payments (`failedAt` in the period), refunds without received money, SOLD outcomes whose charge differs
 *   from the ledger or awaits finance confirmation, and DUPLICATE / UNMATCHED provider events (`receivedAt` in the
 *   period; an event naming no job is only examined by tenant-wide runs).
 */

export interface RunScope {
  tenantId: string;
  legalEntityId: string | null;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
}

/** A finding plus the machine details stored with it (ids, codes, booleans and decimal strings only). */
export interface DetectedFinding extends ReconciliationFinding {
  details: Record<string, string | boolean | null>;
}

export interface Detection {
  findings: DetectedFinding[];
  jobsExamined: number;
  expectedMinor: bigint;
  recordedMinor: bigint;
}

const LIVE_REFUND = { notIn: ["REJECTED", "CANCELLED"] } satisfies Prisma.EnumRefundStatusFilter;

function blank(scope: RunScope): Omit<DetectedFinding, "kind" | "expectedAmountMinor" | "recordedAmountMinor"> {
  return { code: null, currency: scope.currency, jobId: null, paymentId: null, intakeEventId: null, refundId: null, outcomeId: null, orgUnitId: null, details: {} };
}

/** Ledger balances of many jobs in one currency, in two queries (non-reversals grouped; reversals with the type they reverse). */
async function balancesOf(tx: TenantTx, scope: RunScope, jobIds: string[]): Promise<Map<string, LedgerBalance>> {
  const where: Prisma.LedgerEntryWhereInput = { tenantId: scope.tenantId, currency: scope.currency, jobId: { in: jobIds } };
  const grouped = await tx.ledgerEntry.groupBy({ by: ["jobId", "type"], where: { AND: [where, { type: { not: "REVERSAL" } }] }, _sum: { amountMinor: true } });
  const reversals = await tx.ledgerEntry.findMany({
    where: { AND: [where, { type: "REVERSAL" }] },
    select: { jobId: true, amountMinor: true, reverses: { select: { type: true } } },
  });
  const amounts = new Map<string, Array<{ currency: string; effectiveType: EffectiveLedgerType; amountMinor: bigint }>>();
  const add = (jobId: string | null, effectiveType: EffectiveLedgerType, amountMinor: bigint) => {
    if (!jobId) return;
    amounts.set(jobId, [...(amounts.get(jobId) ?? []), { currency: scope.currency, effectiveType, amountMinor }]);
  };
  for (const row of grouped) add(row.jobId, row.type as EffectiveLedgerType, row._sum.amountMinor ?? 0n);
  // `reverses` is always set on a REVERSAL (DB CHECK) and never another REVERSAL (trigger).
  for (const row of reversals) if (row.reverses) add(row.jobId, row.reverses.type as EffectiveLedgerType, row.amountMinor);
  const balances = new Map<string, LedgerBalance>();
  for (const [jobId, list] of amounts) {
    const [balance] = summarizeLedger(list);
    if (balance) balances.set(jobId, balance);
  }
  return balances;
}

export async function detectFindingsInTx(tx: TenantTx, scope: RunScope): Promise<Detection> {
  const { tenantId, currency, legalEntityId } = scope;
  const period = { gte: scope.periodStart, lt: scope.periodEnd };
  // The job's CURRENT unit decides the legal entity for records without a posting snapshot.
  const jobInEntity: Prisma.JobWhereInput = legalEntityId ? { orgUnit: { legalEntityId } } : {};
  const findings: DetectedFinding[] = [];
  const jobIds = new Set<string>();

  const entries = await tx.ledgerEntry.findMany({
    where: { tenantId, currency, occurredAt: period, jobId: { not: null }, type: { not: "MATERIAL_COST" }, ...(legalEntityId ? { legalEntityId } : {}) },
    select: { jobId: true },
    distinct: ["jobId"],
  });
  for (const entry of entries) if (entry.jobId) jobIds.add(entry.jobId);

  // ── Outcomes: reported charge vs posted CHARGE; confirmation still pending ──
  const outcomes = await tx.jobOutcome.findMany({
    where: {
      tenantId,
      currency,
      occurredAt: period,
      job: jobInEntity,
      OR: [
        { outcome: "SOLD", OR: [{ chargedAmountMinor: { gt: 0 } }, { collectedAmountMinor: { gt: 0 } }] },
        { ledgerEntries: { some: { type: "CHARGE" } } },
      ],
    },
    select: {
      id: true,
      jobId: true,
      outcome: true,
      chargedAmountMinor: true,
      collectedAmountMinor: true,
      job: { select: { orgUnitId: true } },
      ledgerEntries: { where: { type: "CHARGE" }, select: { amountMinor: true, reversedBy: { select: { id: true } } } },
      payments: { where: { status: { in: ["PENDING", "RECEIVED"] } }, select: { id: true } },
    },
  });
  for (const outcome of outcomes) {
    jobIds.add(outcome.jobId);
    const verdict = classifyOutcomeCharge({
      chargedAmountMinor: outcome.outcome === "SOLD" ? outcome.chargedAmountMinor : null,
      collectedAmountMinor: outcome.outcome === "SOLD" ? outcome.collectedAmountMinor : null,
      activeChargeMinors: outcome.ledgerEntries.filter((entry) => entry.reversedBy.length === 0).map((entry) => entry.amountMinor),
      activeCollectionCount: outcome.payments.length,
    });
    if (!verdict) continue;
    const base = { ...blank(scope), jobId: outcome.jobId, outcomeId: outcome.id, orgUnitId: outcome.job.orgUnitId };
    if (verdict.kind === "MISMATCH") {
      findings.push({ ...base, kind: "OUTCOME_LEDGER_MISMATCH", expectedAmountMinor: outcome.chargedAmountMinor ?? 0n, recordedAmountMinor: verdict.postedMinor });
    } else {
      findings.push({
        ...base,
        kind: "OTHER",
        code: "finance_confirmation_pending",
        expectedAmountMinor: outcome.chargedAmountMinor,
        recordedAmountMinor: verdict.chargePending ? 0n : null,
        details: { chargePending: verdict.chargePending, collectionPending: verdict.collectionPending },
      });
    }
  }

  // ── Payments: failed ones are exceptions; any payment activity makes its job part of the run ──
  const payments = await tx.payment.findMany({
    where: {
      tenantId,
      currency,
      job: jobInEntity,
      OR: [{ createdAt: period }, { receivedAt: period }, { failedAt: period }, { voidedAt: period }],
    },
    select: { id: true, jobId: true, status: true, amountMinor: true, failedAt: true, job: { select: { orgUnitId: true } } },
  });
  for (const payment of payments) {
    jobIds.add(payment.jobId);
    const failedInPeriod = payment.failedAt && payment.failedAt >= scope.periodStart && payment.failedAt < scope.periodEnd;
    if (payment.status === "FAILED" && failedInPeriod) {
      findings.push({
        ...blank(scope),
        kind: "FAILED_PAYMENT",
        jobId: payment.jobId,
        paymentId: payment.id,
        orgUnitId: payment.job.orgUnitId,
        expectedAmountMinor: payment.amountMinor,
        recordedAmountMinor: 0n,
      });
    }
  }

  // ── Refunds without received money behind them ──
  const refunds = await tx.refund.findMany({
    where: { tenantId, currency, job: jobInEntity, status: LIVE_REFUND, OR: [{ requestedAt: period }, { postedAt: period }] },
    select: {
      id: true,
      jobId: true,
      amountMinor: true,
      job: { select: { orgUnitId: true } },
      payment: { select: { id: true, status: true, amountMinor: true, refunds: { where: { status: LIVE_REFUND }, select: { amountMinor: true } } } },
    },
  });
  const refundJobIds = [...new Set(refunds.filter((refund) => !refund.payment).map((refund) => refund.jobId))];
  const jobsWithReceived = new Set(
    (
      await tx.payment.findMany({
        where: { tenantId, currency, jobId: { in: refundJobIds }, status: "RECEIVED" },
        select: { jobId: true },
        distinct: ["jobId"],
      })
    ).map((row) => row.jobId),
  );
  for (const refund of refunds) {
    jobIds.add(refund.jobId);
    const refundedMinor = refund.payment ? refund.payment.refunds.reduce((sum, row) => sum + row.amountMinor, 0n) : 0n;
    const code = classifyRefund({
      payment: refund.payment ? { status: refund.payment.status, amountMinor: refund.payment.amountMinor, refundedMinor } : null,
      jobHasReceivedPayment: jobsWithReceived.has(refund.jobId),
    });
    if (!code) continue;
    findings.push({
      ...blank(scope),
      kind: "REFUND_WITHOUT_PAYMENT",
      code,
      jobId: refund.jobId,
      refundId: refund.id,
      paymentId: refund.payment?.id ?? null,
      orgUnitId: refund.job.orgUnitId,
      expectedAmountMinor: refund.amountMinor,
      recordedAmountMinor: refund.payment?.status === "RECEIVED" ? refund.payment.amountMinor : 0n,
      details: refund.payment
        ? { paymentStatus: refund.payment.status, paymentAmountMinor: refund.payment.amountMinor.toString(), refundedMinor: refundedMinor.toString() }
        : {},
    });
  }

  // ── Provider events the intake could not use: duplicates (same payment seen again) and unmatched ──
  const intakeEvents = await tx.paymentIntakeEvent.findMany({
    where: {
      tenantId,
      status: { in: ["DUPLICATE", "UNMATCHED"] },
      receivedAt: period,
      // An event without a currency (it failed before one was parsed) is examined by the tenant-wide runs.
      OR: [{ currency }, ...(legalEntityId ? [] : [{ currency: null }])],
      ...(legalEntityId ? { job: { orgUnit: { legalEntityId } } } : {}),
    },
    select: { id: true, status: true, jobId: true, amountMinor: true, duplicateOfId: true, rejectionCode: true, job: { select: { orgUnitId: true } } },
  });
  for (const event of intakeEvents) {
    findings.push({
      ...blank(scope),
      kind: event.status === "DUPLICATE" ? "DUPLICATE_EXTERNAL_EVENT" : "UNMATCHED_PROVIDER_EVENT",
      jobId: event.jobId,
      intakeEventId: event.id,
      orgUnitId: event.job?.orgUnitId ?? null,
      expectedAmountMinor: null,
      recordedAmountMinor: event.amountMinor,
      details: event.status === "DUPLICATE" ? { duplicateOfId: event.duplicateOfId } : { rejectionCode: event.rejectionCode },
    });
  }

  // ── Expected vs recorded for every job the period touched ──
  const examined = [...jobIds];
  const balances = await balancesOf(tx, scope, examined);
  const units = new Map(
    (await tx.job.findMany({ where: { tenantId, id: { in: examined } }, select: { id: true, orgUnitId: true } })).map((job) => [job.id, job.orgUnitId]),
  );
  let expectedMinor = 0n;
  let recordedMinor = 0n;
  for (const jobId of examined) {
    const balance = balances.get(jobId);
    if (!balance) continue;
    expectedMinor += balance.billedMinor;
    recordedMinor += balance.netCollectedMinor;
    const kind = classifyJobBalance(balance);
    if (!kind) continue;
    findings.push({
      ...blank(scope),
      kind,
      jobId,
      orgUnitId: units.get(jobId) ?? null,
      expectedAmountMinor: balance.billedMinor,
      recordedAmountMinor: balance.netCollectedMinor,
      details: { paymentStatus: balance.paymentStatus },
    });
  }

  return { findings, jobsExamined: examined.length, expectedMinor, recordedMinor };
}
