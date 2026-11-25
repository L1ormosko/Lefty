import { CHARGEBACK_STATUSES_HOLDING_PAYMENT, REFUND_STATUSES_HOLDING_PAYMENT, remainingOnPayment } from "@/lib/finance-correction-rules";
import type { TenantTx } from "@/server/db";

/**
 * How much of a received payment is still available to refund or charge back: its amount minus every refund that holds
 * part of it (requested, waiting, approved or paid out) and every chargeback that was not won. The caller holds the payment
 * row lock (`lockPayment`), so concurrent refunds and chargebacks against one payment are counted one after the other.
 */
export async function remainingOnPaymentInTx(tx: TenantTx, tenantId: string, payment: { id: string; amountMinor: bigint }): Promise<bigint> {
  const refunds = await tx.refund.aggregate({ where: { tenantId, paymentId: payment.id, status: { in: [...REFUND_STATUSES_HOLDING_PAYMENT] } }, _sum: { amountMinor: true } });
  const chargebacks = await tx.chargeback.aggregate({
    where: { tenantId, paymentId: payment.id, status: { in: [...CHARGEBACK_STATUSES_HOLDING_PAYMENT] } },
    _sum: { amountMinor: true },
  });
  return remainingOnPayment(payment.amountMinor, refunds._sum.amountMinor ?? 0n, chargebacks._sum.amountMinor ?? 0n);
}
