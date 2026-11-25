import type { PaymentIntakeEvent } from "@prisma/client";
import type { TenantTx } from "@/server/db";
import type { ProviderEvent } from "./provider";

/**
 * Handlers for provider event types other than `payment.received` (which the intake applies itself). A finance module
 * that owns a record type registers one (the adjustments module: `chargeback.opened`), so the payments module does not
 * import it. The intake keeps every guarantee for these events too: the delivery is authenticated, stored first, unique
 * per (tenant, provider, externalId) and processed once under the event's row lock; the handler only VALIDATES the
 * normalized event against LEADRO records and applies it, inside that same transaction.
 */

/** What the handler decided; the intake writes it to the event row with `processedAt` and audits it. */
export interface IntakeVerdict {
  status: "ACCEPTED" | "REJECTED" | "UNMATCHED" | "DUPLICATE";
  /** Required for REJECTED and UNMATCHED (DB CHECK), e.g. "unknown_payment". */
  rejectionCode?: string;
  jobId?: string;
  paymentId?: string;
  duplicateOfId?: string;
}

export interface IntakeEventInput {
  /** The stored event (status RECEIVED, row locked by the caller). */
  event: PaymentIntakeEvent;
  /** The provider's normalized event (already checked by `invalidFields`). */
  incoming: ProviderEvent;
  providerKey: string;
}

export type IntakeEventHandler = (tx: TenantTx, input: IntakeEventInput) => Promise<IntakeVerdict>;

// One Map on globalThis so the instrumentation bundle and the route bundles share it (ARCHITECTURE.md "Registries").
const globalForHandlers = globalThis as unknown as { leadroIntakeEventHandlers?: Map<string, IntakeEventHandler> };
const handlers: Map<string, IntakeEventHandler> = (globalForHandlers.leadroIntakeEventHandlers ??= new Map<string, IntakeEventHandler>());

/** Registers the handler of one event type (idempotent; last one wins). `payment.received` cannot be taken over. */
export function registerIntakeEventHandler(eventType: string, handler: IntakeEventHandler): void {
  // Programming error: the payment flow is the intake's own and must not be replaced from outside.
  if (eventType === "payment.received") throw new Error("payment.received is handled by the intake itself");
  handlers.set(eventType, handler);
}

/** The handler of an event type, or undefined (the event is then REJECTED `unsupported_event_type`). */
export function intakeEventHandler(eventType: string): IntakeEventHandler | undefined {
  return handlers.get(eventType);
}
