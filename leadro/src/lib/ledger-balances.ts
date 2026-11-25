/**
 * Derived ledger balances and the payment status of a job (spec 11.1, 11.8). Pure: no database, no framework.
 *
 * Balances are NEVER stored: they are the sum of append-only ledger entries, recomputed on every read. A REVERSAL entry
 * counts under the type of the entry it reverses (a reversed CHARGE lowers "charged", a voided PAYMENT lowers "collected"),
 * so a correction always shows up in the bucket it corrects.
 *
 * Sign convention (enforced by the database CHECK `ledger_entry_sign_by_type`): CHARGE and PAYMENT are positive, REFUND,
 * CHARGEBACK and MATERIAL_COST negative, ADJUSTMENT either way (positive = the customer owes more, negative = credit).
 */

export const LEDGER_ENTRY_TYPES = ["CHARGE", "PAYMENT", "REFUND", "CHARGEBACK", "ADJUSTMENT", "REVERSAL", "MATERIAL_COST"] as const;
export type LedgerEntryTypeValue = (typeof LEDGER_ENTRY_TYPES)[number];

/** The type an amount counts under: the entry's own type, or for a REVERSAL the type of the entry it reverses. */
export type EffectiveLedgerType = Exclude<LedgerEntryTypeValue, "REVERSAL">;

/** One aggregated (or single) amount: what `summarizeLedger` adds up. */
export interface LedgerAmount {
  currency: string;
  effectiveType: EffectiveLedgerType;
  amountMinor: bigint;
}

/**
 * Payment status of a job (or of any set of entries), per currency:
 * - NOT_CHARGED: nothing billed and nothing (net) collected;
 * - UNPAID: charged, nothing (net) collected;
 * - PARTIAL: net collected is below what was charged;
 * - PAID: net collected equals what was charged;
 * - OVERPAID: net collected exceeds what was charged (including money received with no charge);
 * - REFUNDED: something was refunded and nothing (net) remains collected.
 */
export const JOB_PAYMENT_STATUSES = ["NOT_CHARGED", "UNPAID", "PARTIAL", "PAID", "OVERPAID", "REFUNDED"] as const;
export type JobPaymentStatus = (typeof JOB_PAYMENT_STATUSES)[number];

export interface LedgerBalance {
  currency: string;
  /** CHARGE entries net of their reversals. */
  chargedMinor: bigint;
  /** ADJUSTMENT entries (signed) net of their reversals. */
  adjustedMinor: bigint;
  /** What the customer is billed: charged + adjusted. */
  billedMinor: bigint;
  /** PAYMENT entries net of voids (reversals). */
  collectedMinor: bigint;
  /** Money returned (REFUND), as a positive number. */
  refundedMinor: bigint;
  /** Money taken back by the card network (CHARGEBACK), as a positive number. */
  chargedBackMinor: bigint;
  /** collected - refunded - charged back. */
  netCollectedMinor: bigint;
  /** billed - net collected; negative = the customer is in credit. */
  outstandingMinor: bigint;
  /** Direct material cost (MATERIAL_COST), as a positive number; not part of what the customer owes. */
  materialCostMinor: bigint;
  paymentStatus: JobPaymentStatus;
}

/** The status rule above, from the totals of one currency. */
export function derivePaymentStatus(totals: { billedMinor: bigint; netCollectedMinor: bigint; refundedMinor: bigint }): JobPaymentStatus {
  const { billedMinor, netCollectedMinor, refundedMinor } = totals;
  if (refundedMinor > 0n && netCollectedMinor <= 0n) return "REFUNDED";
  if (billedMinor <= 0n) return netCollectedMinor > 0n ? "OVERPAID" : "NOT_CHARGED";
  if (netCollectedMinor <= 0n) return "UNPAID";
  if (netCollectedMinor < billedMinor) return "PARTIAL";
  if (netCollectedMinor === billedMinor) return "PAID";
  return "OVERPAID";
}

/** Balances per currency (sorted by currency code). Currencies are never mixed: each gets its own balance and status. */
export function summarizeLedger(amounts: Iterable<LedgerAmount>): LedgerBalance[] {
  const byCurrency = new Map<string, Record<EffectiveLedgerType, bigint>>();
  for (const { currency, effectiveType, amountMinor } of amounts) {
    const totals =
      byCurrency.get(currency) ?? { CHARGE: 0n, PAYMENT: 0n, REFUND: 0n, CHARGEBACK: 0n, ADJUSTMENT: 0n, MATERIAL_COST: 0n };
    totals[effectiveType] += amountMinor;
    byCurrency.set(currency, totals);
  }

  return [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, totals]) => {
      const chargedMinor = totals.CHARGE;
      const adjustedMinor = totals.ADJUSTMENT;
      const billedMinor = chargedMinor + adjustedMinor;
      const collectedMinor = totals.PAYMENT;
      const refundedMinor = -totals.REFUND;
      const chargedBackMinor = -totals.CHARGEBACK;
      const netCollectedMinor = collectedMinor - refundedMinor - chargedBackMinor;
      return {
        currency,
        chargedMinor,
        adjustedMinor,
        billedMinor,
        collectedMinor,
        refundedMinor,
        chargedBackMinor,
        netCollectedMinor,
        outstandingMinor: billedMinor - netCollectedMinor,
        materialCostMinor: -totals.MATERIAL_COST,
        paymentStatus: derivePaymentStatus({ billedMinor, netCollectedMinor, refundedMinor }),
      };
    });
}
