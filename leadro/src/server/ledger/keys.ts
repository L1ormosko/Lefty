/**
 * Deterministic ledger idempotency keys (spec 11.8, 20.3, 26.4). A key names the BUSINESS EVENT, so the same event can be
 * posted any number of times (retries, duplicate webhooks, two people clicking at once) and lands in the ledger once.
 * Keys are unique per tenant (DB) and at most 200 characters (DB CHECK); ids are cuids, so every key here fits.
 *
 * Task 5 adds its own (refund / chargeback / adjustment posted); keep one builder per event here so keys never collide.
 */
export const ledgerKeys = {
  /**
   * The CHARGE confirmed from an outcome. `attempt` is 1 for the first posting and goes up by one each time the previous
   * charge of this outcome was reversed (a corrected outcome is re-confirmed), so a re-post never collides with history.
   */
  outcomeCharge: (outcomeId: string, attempt: number): string => `outcome:${outcomeId}:charge:${attempt}`,
  /** The PAYMENT entry of a payment record that became RECEIVED (once per payment). */
  paymentReceived: (paymentId: string): string => `payment:${paymentId}:received`,
  /** The REVERSAL of a received payment that was voided. */
  paymentVoided: (paymentId: string): string => `payment:${paymentId}:void`,
  /** The REVERSAL of any entry (an entry is reversed at most once). */
  reversal: (entryId: string): string => `reversal:${entryId}`,
} as const;

/**
 * Payment-record idempotency keys (`Payment.idempotencyKey`, unique per tenant): what makes CREATING a payment record
 * idempotent, before its ledger entry exists.
 */
export const paymentKeys = {
  /** The collection confirmed from an outcome; `attempt` goes up after the previous one was voided or failed. */
  outcomeCollection: (outcomeId: string, attempt: number): string => `outcome:${outcomeId}:collection:${attempt}`,
  /** A manual payment: the recording user's `Idempotency-Key` (scoped to that user, like the request idempotency store). */
  manual: (userId: string, clientKey: string): string => `manual:${userId}:${clientKey}`,
  /** A provider payment: the provider's own reference, which the provider guarantees unique. */
  provider: (provider: string, providerRef: string): string => `provider:${provider}:${providerRef}`,
} as const;
