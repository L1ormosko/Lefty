import type { PaymentMethod, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, fieldSetsForRow, resolveScope, withinScope } from "@/server/authz";
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { holdsOutcomeFinancialSet } from "@/server/job-outcomes";
import {
  financeJobRef,
  financeJobScopeColumns,
  jobBalanceInTx,
  ledgerKeys,
  loadFinanceJob,
  paymentKeys,
  postLedgerEntryInTx,
  type FinanceJob,
} from "@/server/ledger";
import type { LedgerBalance } from "@/lib/ledger-balances";
import { METHODS_NEEDING_REFERENCE, type ChargesToConfirmQuery, type ConfirmChargeInput, type ConfirmCollectionInput } from "./schemas";
import { createPaymentIdempotently, postPaymentReceivedInTx, toPaymentView, type PaymentView } from "./store";

/**
 * Revenue from outcomes (spec 11.1, 11.8; decision in docs/DECISIONS.md "Phase 4 Task 4"): FINANCE-CONFIRMED, never
 * automatic. The technician's outcome (charged / collected amounts) only feeds the "charges to confirm" queue; a person
 * holding `finance_payments.create` over the job posts the CHARGE entry and records the collection (a MANUAL payment linked
 * to the outcome, whose PAYMENT entry posts at once). Keeping a human between a field report and the books is the
 * oversight spec 11.5 / 28.x ask for, and it lets finance catch a wrong amount before it is revenue.
 *
 * Both confirmations need the outcome's `financial` field set too (`job_outcomes.view`, the one rule for outcome money):
 * they read the technician's amounts. Keys are derived from the outcome (`outcome:<id>:charge:<n>`,
 * `outcome:<id>:collection:<n>`; `n` = 1 + earlier postings of that outcome that were reversed / voided), so a
 * double click or two finance users at once post once.
 */

type ChargeState = "NOT_REQUIRED" | "PENDING" | "POSTED" | "MISMATCH";

export interface ChargeToConfirmView {
  outcomeId: string;
  jobId: string;
  customerId: string;
  visitNumber: number;
  occurredAt: Date;
  currency: string;
  chargedAmountMinor: bigint | null;
  collectedAmountMinor: bigint | null;
  paymentMethod: PaymentMethod | null;
  /** What the technician reported (OUTCOME.PAYMENT_STATUS.*); informational only, finance derives the real status. */
  reportedPaymentStatus: string;
  /** PENDING: not posted; POSTED: the active charge equals the outcome; MISMATCH: they differ (outcome corrected later). */
  charge: { state: ChargeState; postedMinor: bigint; entryId: string | null };
  /** Same, for the collection: payments from this outcome that are PENDING or RECEIVED. */
  collection: { state: ChargeState; recordedMinor: bigint; paymentId: string | null };
}

const queueSelect = {
  id: true,
  jobId: true,
  visitNumber: true,
  occurredAt: true,
  currency: true,
  chargedAmountMinor: true,
  collectedAmountMinor: true,
  paymentMethod: true,
  paymentStatus: true,
  job: { select: { customerId: true, orgUnitId: true, orgUnit: { select: { legalEntityId: true } } } },
  ledgerEntries: { where: { type: "CHARGE" }, select: { id: true, amountMinor: true, reversedBy: { select: { id: true } } } },
  payments: { where: { status: { in: ["PENDING", "RECEIVED"] } }, select: { id: true, amountMinor: true } },
} satisfies Prisma.JobOutcomeSelect;

function stateOf(expected: bigint | null, active: bigint[]): ChargeState {
  const total = active.reduce((sum, amount) => sum + amount, 0n);
  if (!expected || expected === 0n) return active.length > 0 ? "MISMATCH" : "NOT_REQUIRED";
  if (active.length === 0) return "PENDING";
  return total === expected ? "POSTED" : "MISMATCH";
}

/**
 * The confirmation queue: SOLD outcomes carrying a charged or collected amount, oldest first (`occurredAt asc, id asc`).
 * Scope: `finance_payments.view` over the job (in the query) AND the outcome `financial` set over the job (per row: the
 * amounts are outcome money). `state=pending` (default) lists outcomes with a charge or collection not yet posted;
 * `state=all` also shows posted and mismatched ones.
 */
export async function listChargesToConfirm(actor: Actor, query: ChargesToConfirmQuery): Promise<Page<ChargeToConfirmView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "finance_payments.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "finance_payments.view", now);
    const outcomeScope = await resolveScope(tx, actor, "job_outcomes.view", now);

    const filters: Prisma.JobOutcomeWhereInput[] = [
      { outcome: "SOLD" },
      { OR: [{ chargedAmountMinor: { gt: 0 } }, { collectedAmountMinor: { gt: 0 } }] },
    ];
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.state === "pending") {
      filters.push({
        OR: [
          { chargedAmountMinor: { gt: 0 }, ledgerEntries: { none: { type: "CHARGE", reversedBy: { none: {} } } } },
          { collectedAmountMinor: { gt: 0 }, payments: { none: { status: { in: ["PENDING", "RECEIVED"] } } } },
        ],
      });
    }
    const rows = await tx.jobOutcome.findMany({
      where: withinScope<Prisma.JobOutcomeWhereInput>({ job: buildScopeWhere(scope, financeJobScopeColumns, now) }, { tenantId: actor.tenantId, AND: filters }),
      select: queueSelect,
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data = page.data.flatMap((row): ChargeToConfirmView[] => {
      const rowAttributes = { orgUnitIds: [row.job.orgUnitId], legalEntityIds: row.job.orgUnit.legalEntityId ? [row.job.orgUnit.legalEntityId] : [] };
      // Outcome money is the `financial` set of job_outcomes: a finance grant alone does not reveal it (spec 22.2).
      if (!fieldSetsForRow(outcomeScope, rowAttributes).includes("financial")) return [];
      const activeCharges = row.ledgerEntries.filter((entry) => entry.reversedBy.length === 0);
      return [
        {
          outcomeId: row.id,
          jobId: row.jobId,
          customerId: row.job.customerId,
          visitNumber: row.visitNumber,
          occurredAt: row.occurredAt,
          currency: row.currency,
          chargedAmountMinor: row.chargedAmountMinor,
          collectedAmountMinor: row.collectedAmountMinor,
          paymentMethod: row.paymentMethod,
          reportedPaymentStatus: row.paymentStatus,
          charge: {
            state: stateOf(row.chargedAmountMinor, activeCharges.map((entry) => entry.amountMinor)),
            postedMinor: activeCharges.reduce((sum, entry) => sum + entry.amountMinor, 0n),
            entryId: activeCharges[0]?.id ?? null,
          },
          collection: {
            state: stateOf(row.collectedAmountMinor, row.payments.map((payment) => payment.amountMinor)),
            recordedMinor: row.payments.reduce((sum, payment) => sum + payment.amountMinor, 0n),
            paymentId: row.payments[0]?.id ?? null,
          },
        },
      ];
    });
    return { data, page: page.page };
  });
}

interface LoadedOutcome {
  outcome: { id: string; outcome: string; chargedAmountMinor: bigint | null; collectedAmountMinor: bigint | null; currency: string; paymentMethod: PaymentMethod | null; occurredAt: Date };
  job: FinanceJob;
}

/** Loads the outcome and its job and checks: `finance_payments.create` over the job, plus the outcome `financial` set. */
async function loadForConfirmation(tx: TenantTx, actor: Actor, outcomeId: string): Promise<LoadedOutcome> {
  await enforceInTx(tx, actor, "finance_payments.create");
  const outcome = await tx.jobOutcome.findFirst({
    where: { id: outcomeId, tenantId: actor.tenantId },
    select: { id: true, jobId: true, outcome: true, chargedAmountMinor: true, collectedAmountMinor: true, currency: true, paymentMethod: true, occurredAt: true },
  });
  if (!outcome) throw new NotFoundError();
  const job = await loadFinanceJob(tx, actor.tenantId, outcome.jobId);
  if (!job) throw new NotFoundError();
  await enforceInTx(tx, actor, "finance_payments.create", financeJobRef(job));
  if (!(await holdsOutcomeFinancialSet(tx, actor, financeJobRef(job)))) {
    throw new ForbiddenError({
      message: "Confirming revenue needs access to the outcome's amounts.",
      details: [{ field: "outcomeId", code: "revenue.financial_set_required", message: "Confirming revenue needs access to the outcome's amounts." }],
    });
  }
  return { outcome, job };
}

function assertConfirmable(outcome: LoadedOutcome["outcome"], amount: bigint | null, expected: bigint, what: "charge" | "collection"): bigint {
  if (outcome.outcome !== "SOLD" || !amount || amount <= 0n) {
    const message = `This outcome has no ${what} to confirm.`;
    throw new InvalidStateTransitionError({ message, details: [{ field: "outcomeId", code: `revenue.nothing_to_${what === "charge" ? "charge" : "collect"}`, message }] });
  }
  if (amount !== expected) {
    const message = "The outcome's amount changed since it was shown; reload and confirm again.";
    throw new ConflictError({ message, details: [{ field: "body.expectedAmountMinor", code: "revenue.outcome_changed", message }] });
  }
  return amount;
}

export interface ConfirmedCharge {
  entryId: string;
  amountMinor: bigint;
  currency: string;
  replayed: boolean;
  balances: LedgerBalance[];
}

/**
 * Posts the CHARGE of an outcome (source OUTCOME, `occurredAt` = the visit). Refused while another charge of this outcome
 * is active with a different amount (409 `revenue.charge_already_posted`: reverse it first, then confirm again). The
 * same amount again is a replay.
 */
export async function confirmOutcomeCharge(actor: Actor, ctx: RequestContext, outcomeId: string, input: ConfirmChargeInput): Promise<ConfirmedCharge> {
  return withTenant(actor.tenantId, async (tx) => {
    const { outcome, job } = await loadForConfirmation(tx, actor, outcomeId);
    const amount = assertConfirmable(outcome, outcome.chargedAmountMinor, input.expectedAmountMinor, "charge");

    const charges = await tx.ledgerEntry.findMany({
      where: { tenantId: actor.tenantId, outcomeId: outcome.id, type: "CHARGE" },
      select: { id: true, amountMinor: true, reversedBy: { select: { id: true } } },
    });
    const active = charges.find((entry) => entry.reversedBy.length === 0);
    if (active) {
      if (active.amountMinor === amount) {
        return { entryId: active.id, amountMinor: amount, currency: outcome.currency, replayed: true, balances: await jobBalanceInTx(tx, actor.tenantId, job.id) };
      }
      const message = "This outcome already has a posted charge with a different amount; reverse it before confirming again.";
      throw new InvalidStateTransitionError({ message, details: [{ field: "outcomeId", code: "revenue.charge_already_posted", message }] });
    }

    const { entry, replayed } = await postLedgerEntryInTx(tx, {
      tenantId: actor.tenantId,
      type: "CHARGE",
      source: "OUTCOME",
      amountMinor: amount,
      currency: outcome.currency,
      job,
      refs: { outcomeId: outcome.id },
      idempotencyKey: ledgerKeys.outcomeCharge(outcome.id, charges.length + 1),
      actor: { userId: actor.userId },
      occurredAt: outcome.occurredAt,
    });
    if (!replayed) {
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "revenue.charge_confirm",
        targetType: "JobOutcome",
        targetId: outcome.id,
        newValue: { entryId: entry.id, jobId: job.id, amountMinor: amount.toString(), currency: outcome.currency },
      });
    }
    return { entryId: entry.id, amountMinor: amount, currency: outcome.currency, replayed, balances: await jobBalanceInTx(tx, actor.tenantId, job.id) };
  });
}

/**
 * Records the collection the technician reported as a RECEIVED MANUAL payment linked to the outcome (`receivedAt` = the
 * visit) and posts its PAYMENT entry. Refused while another PENDING / RECEIVED payment of this outcome has a different
 * amount (409 `revenue.collection_already_recorded`: void it first).
 */
export async function confirmOutcomeCollection(
  actor: Actor,
  ctx: RequestContext,
  outcomeId: string,
  input: ConfirmCollectionInput,
): Promise<{ payment: PaymentView; replayed: boolean; balances: LedgerBalance[] }> {
  return withTenant(actor.tenantId, async (tx) => {
    const { outcome, job } = await loadForConfirmation(tx, actor, outcomeId);
    const amount = assertConfirmable(outcome, outcome.collectedAmountMinor, input.expectedAmountMinor, "collection");
    const method = input.method ?? outcome.paymentMethod;
    if (!method) {
      throw new ValidationError({ message: "Say how the money was paid.", field: "body.method", details: [{ field: "body.method", code: "revenue.method_required", message: "Say how the money was paid." }] });
    }
    if (METHODS_NEEDING_REFERENCE.has(method) && !input.reference) {
      throw new ValidationError({ message: "A reference is required for this payment method.", field: "body.reference" });
    }

    const earlier = await tx.payment.findMany({ where: { tenantId: actor.tenantId, outcomeId: outcome.id, origin: "MANUAL" } });
    const active = earlier.find((payment) => payment.status === "PENDING" || payment.status === "RECEIVED");
    if (active) {
      if (active.amountMinor === amount) return { payment: toPaymentView(active), replayed: true, balances: await jobBalanceInTx(tx, actor.tenantId, job.id) };
      const message = "A payment from this outcome is already recorded with a different amount; void it before confirming again.";
      throw new InvalidStateTransitionError({ message, details: [{ field: "outcomeId", code: "revenue.collection_already_recorded", message }] });
    }

    const { payment, replayed } = await createPaymentIdempotently(tx, actor.tenantId, job, paymentKeys.outcomeCollection(outcome.id, earlier.length + 1), {
      origin: "MANUAL",
      method,
      status: "RECEIVED",
      amountMinor: amount,
      currency: outcome.currency,
      reference: input.reference ?? null,
      outcomeId: outcome.id,
      receivedAt: outcome.occurredAt,
      recordedById: actor.userId,
    });
    if (!replayed) {
      await postPaymentReceivedInTx(tx, payment, job, { userId: actor.userId });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "revenue.collection_confirm",
        targetType: "JobOutcome",
        targetId: outcome.id,
        newValue: { paymentId: payment.id, jobId: job.id, method, amountMinor: amount.toString(), currency: outcome.currency },
      });
    }
    return { payment: toPaymentView(payment), replayed, balances: await jobBalanceInTx(tx, actor.tenantId, job.id) };
  });
}
