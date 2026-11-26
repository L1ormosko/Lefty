import { createHash } from "node:crypto";
import type { PaymentIntakeEvent, PaymentIntakeStatus, Prisma } from "@prisma/client";
import { currencyCodeSchema, MAX_MONEY_MINOR } from "@/lib/money";
import { recordAudit } from "@/server/audit";
import { ConflictError, UnauthenticatedError } from "@/server/core";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { loadFinanceJob, paymentKeys } from "@/server/ledger";
import { intakeEventHandler } from "./intake-handlers";
import { getPaymentProvider, providerNotConfigured, type PaymentProvider, type ProviderEvent } from "./provider";
import { createPaymentIdempotently, postPaymentReceivedInTx } from "./store";

/**
 * The authenticated, idempotent intake of payment provider events (spec 18.3, 26.4). Order matters:
 *
 *  1. The provider must be configured and the tenant must exist, else 409 `payment_provider.not_configured` and NOTHING
 *     is written (both cases answer the same, so the endpoint is no tenant oracle). In this build no provider exists.
 *  2. The provider authenticates the delivery with its per-tenant secret over the RAW body. A bad signature is logged as a
 *     REJECTED event under a hash-derived id (`unverified:<sha256>`), never under the id the body claims, so a forger cannot
 *     squat a real event id and make the genuine delivery look like a duplicate; the caller gets 401.
 *  3. The verified event is stored FIRST (`PaymentIntakeEvent`, status RECEIVED, payload SHA-256 only, never the raw
 *     body) and committed, so every delivery is on record even if processing fails. Unique per (tenant, provider,
 *     externalId): a duplicate delivery, sequential or concurrent, finds the existing row and posts nothing.
 *  4. Processing runs under a row lock on the event and VALIDATES before touching core records: known event type, the job
 *     exists, same currency, the provider's payment reference not seen before. Only then a PROVIDER payment (RECEIVED) and
 *     its PAYMENT ledger entry (`system:provider-intake`) are written, in the same transaction as the event's final status.
 *     An event left RECEIVED by a crash is processed by the provider's next retry.
 */

export const INTAKE_SYSTEM_ACTOR = "system:provider-intake";

export interface IntakeRequest {
  tenantSlug: string;
  providerKey: string;
  rawBody: string;
  headers: Headers;
}

export interface IntakeResult {
  eventId: string;
  status: PaymentIntakeStatus;
  rejectionCode: string | null;
  paymentId: string | null;
  /** True when this delivery repeated an event already on record (nothing new was posted). */
  duplicate: boolean;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const toResult = (event: PaymentIntakeEvent, duplicate: boolean): IntakeResult => ({
  eventId: event.id,
  status: event.status,
  rejectionCode: event.rejectionCode,
  paymentId: event.paymentId,
  duplicate,
});

/** Inserts the event unless (tenant, provider, externalId) exists; returns the row on record and whether it was new. */
async function claimEvent(tx: TenantTx, data: Prisma.PaymentIntakeEventCreateManyInput): Promise<{ event: PaymentIntakeEvent; inserted: boolean }> {
  const { count } = await tx.paymentIntakeEvent.createMany({ data: [data], skipDuplicates: true });
  const event = await tx.paymentIntakeEvent.findUniqueOrThrow({
    where: { tenantId_provider_externalId: { tenantId: data.tenantId, provider: data.provider, externalId: data.externalId } },
  });
  return { event, inserted: count === 1 };
}

/** Defence against a faulty provider parser: the normalized fields must fit the columns and the money rules. */
function invalidFields(event: ProviderEvent): boolean {
  const text = (value: string, max: number) => value.trim().length > 0 && value.length <= max;
  if (!text(event.externalId, 200) || !text(event.eventType, 100)) return true;
  if (event.occurredAt && Number.isNaN(event.occurredAt.getTime())) return true;
  const badMoney = (amountMinor: bigint, currency: string) => amountMinor <= 0n || amountMinor > MAX_MONEY_MINOR || !currencyCodeSchema.safeParse(currency).success;
  const payment = event.payment;
  if (payment && (!text(payment.jobId, 64) || !text(payment.providerRef, 200) || badMoney(payment.amountMinor, payment.currency))) return true;
  const chargeback = event.chargeback;
  if (
    chargeback &&
    (!text(chargeback.paymentProviderRef, 200) ||
      !text(chargeback.chargebackRef, 200) ||
      (chargeback.reasonCode !== undefined && !text(chargeback.reasonCode, 50)) ||
      badMoney(chargeback.amountMinor, chargeback.currency))
  ) {
    return true;
  }
  return false;
}

/** The normalized fields stored on the event (ids, codes, amounts as decimal strings); never the raw provider payload. */
function parsedFields(incoming: ProviderEvent): Prisma.InputJsonObject {
  if (incoming.payment) {
    const p = incoming.payment;
    return { eventType: incoming.eventType, jobId: p.jobId, amountMinor: p.amountMinor.toString(), currency: p.currency, providerRef: p.providerRef, method: p.method ?? null };
  }
  if (incoming.chargeback) {
    const c = incoming.chargeback;
    return {
      eventType: incoming.eventType,
      paymentProviderRef: c.paymentProviderRef,
      chargebackRef: c.chargebackRef,
      amountMinor: c.amountMinor.toString(),
      currency: c.currency,
      reasonCode: c.reasonCode ?? null,
    };
  }
  return { eventType: incoming.eventType };
}

/** Receives one delivery; see the module comment for the order of checks. */
export async function receiveProviderEvent(request: IntakeRequest): Promise<IntakeResult> {
  const provider = getPaymentProvider(request.providerKey);
  const tenant = provider ? await prisma.tenant.findUnique({ where: { slug: request.tenantSlug }, select: { id: true, status: true } }) : null;
  if (!provider || !tenant || tenant.status !== "ACTIVE") throw providerNotConfigured();
  const tenantId = tenant.id;
  const payloadHash = sha256(request.rawBody);

  let verified = false;
  try {
    verified = await provider.verifyEvent({ tenantId, rawBody: request.rawBody, headers: request.headers });
  } catch {
    verified = false; // a provider that cannot verify must never let the event through
  }
  if (!verified) {
    await withTenant(tenantId, (tx) =>
      claimEvent(tx, {
        tenantId,
        provider: provider.key,
        externalId: `unverified:${payloadHash}`,
        eventType: "unverified",
        payloadHash,
        signatureValid: false,
        status: "REJECTED",
        rejectionCode: "bad_signature",
        processedAt: new Date(),
      }),
    );
    throw new UnauthenticatedError({ message: "The event signature could not be verified." });
  }

  const parsed = safeParse(provider, request.rawBody);
  if (!parsed.ok || invalidFields(parsed.event)) {
    const code = parsed.ok ? "invalid_event_fields" : parsed.code;
    const { event, inserted } = await withTenant(tenantId, (tx) =>
      claimEvent(tx, {
        tenantId,
        provider: provider.key,
        externalId: (!parsed.ok && parsed.externalId) || `unparsed:${payloadHash}`,
        eventType: (!parsed.ok && parsed.eventType) || "unknown",
        payloadHash,
        signatureValid: true,
        status: "REJECTED",
        rejectionCode: code,
        processedAt: new Date(),
      }),
    );
    return toResult(event, !inserted);
  }

  const incoming = parsed.event;
  const { event, inserted } = await withTenant(tenantId, (tx) =>
    claimEvent(tx, {
      tenantId,
      provider: provider.key,
      externalId: incoming.externalId,
      eventType: incoming.eventType,
      payloadHash,
      signatureValid: true,
      occurredAt: incoming.occurredAt ?? null,
      amountMinor: incoming.payment?.amountMinor ?? incoming.chargeback?.amountMinor ?? null,
      currency: incoming.payment?.currency ?? incoming.chargeback?.currency ?? null,
      // Normalized fields only, amounts as decimal strings; never the raw provider payload (it may carry card data).
      parsed: parsedFields(incoming),
    }),
  );
  if (!inserted && event.payloadHash !== payloadHash) {
    throw new ConflictError({
      message: "An event with this id was already received with different content.",
      details: [{ field: "externalId", code: "payment_intake.payload_mismatch", message: "An event with this id was already received with different content." }],
    });
  }
  return withTenant(tenantId, (tx) => processEvent(tx, event.id, incoming, provider.key));
}

function safeParse(provider: PaymentProvider, rawBody: string): ReturnType<PaymentProvider["parseEvent"]> {
  try {
    return provider.parseEvent(rawBody);
  } catch {
    return { ok: false, code: "malformed_event" };
  }
}

/** Validates and applies a RECEIVED event under a row lock (a concurrent duplicate waits, then sees the final status). */
async function processEvent(tx: TenantTx, eventId: string, incoming: ProviderEvent, providerKey: string): Promise<IntakeResult> {
  await tx.$queryRaw`SELECT "id" FROM "PaymentIntakeEvent" WHERE "id" = ${eventId} FOR UPDATE`;
  const event = await tx.paymentIntakeEvent.findUniqueOrThrow({ where: { id: eventId } });
  // Already decided by an earlier (or concurrent) delivery: report it, post nothing.
  if (event.status !== "RECEIVED") return toResult(event, true);
  // Still RECEIVED: this delivery decides it (first delivery, or a retry after a crash between storing and processing).

  const finish = async (status: PaymentIntakeStatus, data: Prisma.PaymentIntakeEventUncheckedUpdateInput = {}): Promise<IntakeResult> => {
    const updated = await tx.paymentIntakeEvent.update({ where: { id: event.id }, data: { ...data, status, processedAt: new Date() } });
    await recordAudit(tx, {
      tenantId: event.tenantId,
      actorUserId: null,
      action: "payment_intake.process",
      targetType: "PaymentIntakeEvent",
      targetId: event.id,
      newValue: { provider: providerKey, status, rejectionCode: updated.rejectionCode, paymentId: updated.paymentId, jobId: updated.jobId },
      sourceApp: "SYSTEM",
    });
    return toResult(updated, false);
  };

  if (incoming.eventType !== "payment.received") {
    // Other event types belong to the module that registered them (chargebacks: the adjustments module).
    const handler = intakeEventHandler(incoming.eventType);
    if (!handler) return finish("REJECTED", { rejectionCode: "unsupported_event_type" });
    const verdict = await handler(tx, { event, incoming, providerKey });
    return finish(verdict.status, {
      rejectionCode: verdict.rejectionCode ?? null,
      jobId: verdict.jobId ?? null,
      paymentId: verdict.paymentId ?? null,
      duplicateOfId: verdict.duplicateOfId ?? null,
    });
  }
  const payment = incoming.payment;
  if (!payment) return finish("REJECTED", { rejectionCode: "unsupported_event_type" });
  const job = await loadFinanceJob(tx, event.tenantId, payment.jobId);
  if (!job) return finish("UNMATCHED", { rejectionCode: "unknown_job" });
  if (payment.currency !== job.currency) return finish("REJECTED", { rejectionCode: "currency_mismatch", jobId: job.id });

  const earlier = await tx.payment.findFirst({ where: { tenantId: event.tenantId, provider: providerKey, providerRef: payment.providerRef }, select: { intakeEventId: true } });
  if (earlier) return finish("DUPLICATE", { rejectionCode: "duplicate_provider_ref", duplicateOfId: earlier.intakeEventId, jobId: job.id });

  const { payment: created } = await createPaymentIdempotently(tx, event.tenantId, job, paymentKeys.provider(providerKey, payment.providerRef), {
    origin: "PROVIDER",
    method: payment.method ?? "CARD",
    status: "RECEIVED",
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    provider: providerKey,
    providerRef: payment.providerRef,
    intakeEventId: event.id,
    receivedAt: incoming.occurredAt ?? new Date(),
  });
  await postPaymentReceivedInTx(tx, created, job, { system: INTAKE_SYSTEM_ACTOR });
  return finish("ACCEPTED", { paymentId: created.id, jobId: job.id });
}
