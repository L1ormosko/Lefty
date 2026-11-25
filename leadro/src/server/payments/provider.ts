import { createHmac, timingSafeEqual } from "node:crypto";
import { ConflictError } from "@/server/core";
import type { PaymentMethodValue } from "./schemas";

/**
 * The payment processor boundary (spec 18.3, 28.3: no fake integrations). No processor is wired up in this build, so the
 * registry is EMPTY by default: every provider key is "not configured" and its intake endpoint refuses every event
 * truthfully (409 `payment_provider.not_configured`) before anything is written.
 *
 * A real integration implements `PaymentProvider` and is installed once at start-up with `registerPaymentProvider`. It
 * owns two things only: authenticating a delivery with ITS per-tenant secret (`verifyEvent`) and normalizing a verified
 * body into a `ProviderEvent` (`parseEvent`). Everything that touches LEADRO records (logging the event, validating it
 * against the job, idempotency, posting) stays in `intake.ts`, the same for every provider.
 *
 * Secrets: there is no connection table yet (docs/DECISIONS.md Phase 4 Task 1); a real provider will resolve its
 * per-tenant secret from an encrypted connection record in a later migration. Never put a secret in code or config files.
 */

/** A payment event in LEADRO terms. Amounts are minor units; ids are the provider's. */
export interface ProviderEvent {
  /** The provider's unique id of this EVENT (a retry of the same delivery carries the same id). */
  externalId: string;
  /** Normalized type; the intake acts on `payment.received` and refuses others as unsupported. */
  eventType: string;
  occurredAt?: Date;
  payment?: {
    /** The LEADRO job the payment is for (the integration put it in the payment's metadata). */
    jobId: string;
    amountMinor: bigint;
    currency: string;
    /** The provider's id of the PAYMENT (unique per provider): a second event about it never posts twice. */
    providerRef: string;
    method?: PaymentMethodValue;
  };
}

export type ParseResult =
  | { ok: true; event: ProviderEvent }
  /** The body verified but could not be understood; `externalId` / `eventType` when the provider could still read them. */
  | { ok: false; code: string; externalId?: string; eventType?: string };

export interface VerifyRequest {
  tenantId: string;
  rawBody: string;
  headers: Headers;
}

export interface PaymentProvider {
  /** Lowercase key used in the intake URL and stored on every event (`PaymentIntakeEvent.provider`). */
  readonly key: string;
  /** True when the delivery is authentic for this tenant (signature over the RAW body with the tenant's secret). */
  verifyEvent(request: VerifyRequest): Promise<boolean>;
  /** Normalizes a verified body. Must not throw for bad input: return `{ ok: false, code }`. */
  parseEvent(rawBody: string): ParseResult;
}

/** Detail code clients key their "no payment provider is set up" message on (i18n `FINANCE.PROVIDER.NOT_CONFIGURED`). */
export const PAYMENT_PROVIDER_NOT_CONFIGURED = "payment_provider.not_configured";

export function providerNotConfigured(): ConflictError {
  return new ConflictError({
    message: "No payment provider is configured for this destination, so provider events cannot be accepted.",
    details: [{ field: "provider", code: PAYMENT_PROVIDER_NOT_CONFIGURED, message: "No payment provider is configured." }],
  });
}

// One Map on globalThis so the instrumentation bundle and the route bundles share it (ARCHITECTURE.md "Registries").
const globalForProviders = globalThis as unknown as { leadroPaymentProviders?: Map<string, PaymentProvider> };
const providers: Map<string, PaymentProvider> = (globalForProviders.leadroPaymentProviders ??= new Map<string, PaymentProvider>());

/** Installs a provider (start-up; tests). Registering the same key again replaces it. */
export function registerPaymentProvider(provider: PaymentProvider): void {
  providers.set(provider.key, provider);
}

/** Test hook: back to the default, "nothing configured". */
export function resetPaymentProviders(): void {
  providers.clear();
}

/** The provider for `key`, or undefined when none is configured (the default for every key). */
export const getPaymentProvider = (key: string): PaymentProvider | undefined => providers.get(key);

/** Keys of the configured providers (empty in this build). */
export const configuredPaymentProviders = (): string[] => [...providers.keys()].sort();

/**
 * Constant-time check of a hex HMAC-SHA256 signature over the raw body: the building block most providers' webhook
 * signatures use. Returns false (never throws) for a missing or malformed signature.
 */
export function hmacSha256Matches(secret: string, rawBody: string, signatureHex: string | null): boolean {
  if (!signatureHex || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(signatureHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
