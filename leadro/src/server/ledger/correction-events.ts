import type { TenantTx } from "@/server/db";

/**
 * The domain event "money was taken out of the books by a single-person correction", published INSIDE the correcting
 * transaction: a CHARGE reversed (`reverseCharge`) or a RECEIVED payment voided (payments `voidPayment`). Neither needs an
 * approval, so the finance-adjustments module subscribes and raises a finance review flag: another finance person sees every
 * such correction (spec 21.3, 11.7; review finding P4-R2). Same pattern as `onJobStatusChanged` (ARCHITECTURE.md "Registries").
 *
 * Payload: ids and money only. `reversalEntryId` identifies the correction (a deterministic anchor for idempotent reactions).
 */
export interface LedgerCorrectionEvent {
  tenantId: string;
  kind: "CHARGE_REVERSED" | "PAYMENT_VOIDED";
  jobId: string;
  customerId: string;
  /** The job's current service-area unit (the scope of whoever reviews it). */
  orgUnitId: string;
  /** The entry that was reversed (the CHARGE, or the payment's PAYMENT entry). */
  originalEntryId: string;
  /** The REVERSAL entry just posted. */
  reversalEntryId: string;
  paymentId: string | null;
  outcomeId: string | null;
  /** The amount taken out (positive minor units) and its currency. */
  amountMinor: bigint;
  currency: string;
  /** The person who made the correction. */
  actorUserId: string;
}

export type LedgerCorrectionHandler = (tx: TenantTx, event: LedgerCorrectionEvent) => Promise<void>;

// One Map on globalThis so the instrumentation bundle and the route bundles share it (ARCHITECTURE.md "Registries").
const globalForHandlers = globalThis as unknown as { leadroLedgerCorrectionHandlers?: Map<string, LedgerCorrectionHandler> };
const handlers: Map<string, LedgerCorrectionHandler> = (globalForHandlers.leadroLedgerCorrectionHandlers ??= new Map<string, LedgerCorrectionHandler>());

/**
 * Subscribes `handler` (once per `name`; registering the same name again replaces it). A handler that throws aborts the
 * correction: subscribe only handlers whose failure should block it.
 */
export function onLedgerCorrection(name: string, handler: LedgerCorrectionHandler): void {
  handlers.set(name, handler);
}

/** Test hook: forget one subscriber (or all). */
export function resetLedgerCorrectionHandlers(name?: string): void {
  if (name) handlers.delete(name);
  else handlers.clear();
}

/** Called by the correcting service in its transaction, after the REVERSAL entry was posted (not on a replay). */
export async function publishLedgerCorrection(tx: TenantTx, event: LedgerCorrectionEvent): Promise<void> {
  for (const handler of handlers.values()) await handler(tx, event);
}
