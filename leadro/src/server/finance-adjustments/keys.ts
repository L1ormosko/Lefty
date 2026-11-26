/**
 * Deterministic keys of this module (spec 20.3, 26.4). A key names the BUSINESS EVENT, so retries, double clicks,
 * concurrent requests and duplicate webhooks land once. Ledger keys are unique per tenant (`LedgerEntry.idempotencyKey`),
 * approval keys too (`ApprovalRequest.idempotencyKey`, prefixed with the subject type as the engine asks), flag keys too
 * (`FinanceReviewFlag.idempotencyKey`). Ids are cuids, so every key stays far below the 200-character CHECK.
 */

export const REFUND_SUBJECT = "REFUND" as const;
export const ADJUSTMENT_SUBJECT = "ADJUSTMENT" as const;
export const CHARGEBACK_WRITE_OFF_SUBJECT = "CHARGEBACK_WRITE_OFF" as const;

export const correctionLedgerKeys = {
  /** The REFUND entry when a refund is paid out (once per refund). */
  refundPosted: (refundId: string): string => `refund:${refundId}:posted`,
  /** The CHARGEBACK entry when a chargeback is opened (once per chargeback). */
  chargebackOpened: (chargebackId: string): string => `chargeback:${chargebackId}:opened`,
  /** The REVERSAL of the CHARGEBACK entry when the dispute is won (the money came back). */
  chargebackWon: (chargebackId: string): string => `chargeback:${chargebackId}:won`,
  /** The ADJUSTMENT entry when an adjustment is posted (once per adjustment). */
  adjustmentPosted: (adjustmentId: string): string => `adjustment:${adjustmentId}:posted`,
} as const;

export const correctionApprovalKeys = {
  refund: (refundId: string): string => `${REFUND_SUBJECT}:${refundId}`,
  adjustment: (adjustmentId: string): string => `${ADJUSTMENT_SUBJECT}:${adjustmentId}`,
  /** `attempt` = 1 + earlier write-off requests of the chargeback (a rejected write-off may be asked for again). */
  chargebackWriteOff: (chargebackId: string, attempt: number): string => `${CHARGEBACK_WRITE_OFF_SUBJECT}:${chargebackId}:${attempt}`,
} as const;

/** `Adjustment.idempotencyKey` of the system adjustment that writes a lost chargeback off (once per chargeback). */
export const chargebackWriteOffAdjustmentKey = (chargebackId: string): string => `chargeback:${chargebackId}:write_off`;

/** `Chargeback.idempotencyKey` of a provider chargeback: the provider's own reference, which it guarantees unique. */
export const providerChargebackKey = (provider: string, chargebackRef: string): string => `provider:${provider}:${chargebackRef}`;

export const reviewFlagKeys = {
  jobReopened: (statusHistoryId: string): string => `job_reopened:${statusHistoryId}`,
  outcomeCorrected: (jobEventId: string): string => `outcome_corrected:${jobEventId}`,
  refundPosted: (refundId: string): string => `refund_posted:${refundId}`,
  chargebackOpened: (chargebackId: string): string => `chargeback_opened:${chargebackId}`,
  materialCostCurrency: (usageId: string): string => `material_cost_currency:${usageId}`,
  /** One flag per single-person correction: the REVERSAL entry it posted names it. */
  ledgerCorrection: (reversalEntryId: string): string => `ledger_correction:${reversalEntryId}`,
} as const;
