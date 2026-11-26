import { INTAKE_SYSTEM_ACTOR, registerIntakeEventHandler, type IntakeEventHandler } from "@/server/payments";
import { lockPayment, requireFinanceJob } from "./common";
import { openChargebackInTx } from "./chargebacks";
import { providerChargebackKey } from "./keys";

/**
 * Provider chargebacks (`chargeback.opened`) through the payments intake (spec 18.3, 26.4). The intake has already
 * authenticated the delivery, stored the event first and locked its row; this handler validates the normalized event
 * against LEADRO records BEFORE writing anything, in this order:
 *  1. the event carries chargeback fields (else REJECTED `missing_chargeback`);
 *  2. the disputed payment is a known provider payment of this provider (else UNMATCHED `unknown_payment`);
 *  3. same currency as that payment (else REJECTED `currency_mismatch`);
 *  4. the provider's chargeback reference was not seen before (else DUPLICATE, pointing to the first event).
 * Only then the chargeback is opened (CHARGEBACK entry by `system:provider-intake`, review flag). A duplicate delivery of
 * the same event never reaches this handler twice (the intake answers it from the event row).
 */
export const handleChargebackOpened: IntakeEventHandler = async (tx, { event, incoming, providerKey }) => {
  const chargeback = incoming.chargeback;
  if (!chargeback) return { status: "REJECTED", rejectionCode: "missing_chargeback" };
  const tenantId = event.tenantId;
  const found = await tx.payment.findFirst({ where: { tenantId, provider: providerKey, providerRef: chargeback.paymentProviderRef }, select: { id: true } });
  if (!found) return { status: "UNMATCHED", rejectionCode: "unknown_payment" };
  const payment = await lockPayment(tx, tenantId, found.id);
  if (payment.currency !== chargeback.currency) return { status: "REJECTED", rejectionCode: "currency_mismatch", jobId: payment.jobId, paymentId: payment.id };

  const earlier = await tx.chargeback.findFirst({ where: { tenantId, provider: providerKey, providerRef: chargeback.chargebackRef }, select: { intakeEventId: true } });
  if (earlier) return { status: "DUPLICATE", rejectionCode: "duplicate_provider_ref", duplicateOfId: earlier.intakeEventId ?? undefined, jobId: payment.jobId, paymentId: payment.id };

  const job = await requireFinanceJob(tx, tenantId, payment.jobId);
  await openChargebackInTx(tx, {
    tenantId,
    job,
    payment,
    amountMinor: chargeback.amountMinor,
    currency: chargeback.currency,
    idempotencyKey: providerChargebackKey(providerKey, chargeback.chargebackRef),
    reasonCode: chargeback.reasonCode ?? null,
    notes: null,
    openedAt: incoming.occurredAt && incoming.occurredAt.getTime() <= Date.now() ? incoming.occurredAt : new Date(),
    provider: { key: providerKey, chargebackRef: chargeback.chargebackRef, intakeEventId: event.id },
    recordedById: null,
    actor: { system: INTAKE_SYSTEM_ACTOR },
    ctx: null,
  });
  return { status: "ACCEPTED", jobId: job.id, paymentId: payment.id };
};

/** Plugs `chargeback.opened` into the payments intake (idempotent; at module load and from notification-targets). */
export function registerChargebackIntake(): void {
  registerIntakeEventHandler("chargeback.opened", handleChargebackOpened);
}
