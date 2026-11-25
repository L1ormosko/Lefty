import { z } from "zod";
import { currencyCodeSchema, moneyAmountSchema } from "@/lib/money";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the payments, revenue-confirmation and provider-intake API (`/api/v1/finance/**`). */

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
/** A payment is never zero (DB CHECK payment_amount_positive). */
const positiveMoney = moneyAmountSchema.refine((amount) => amount > 0n, "Must be greater than zero");

export const PAYMENT_METHODS = ["CASH", "CARD", "CHECK", "BANK_TRANSFER", "FINANCING", "OTHER"] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

/**
 * Methods that leave a paper or electronic trail, so the person recording them must type its reference (check number,
 * card-terminal slip, bank reference). Cash, financing and "other" may go without.
 */
export const METHODS_NEEDING_REFERENCE: ReadonlySet<PaymentMethodValue> = new Set(["CHECK", "CARD", "BANK_TRANSFER"]);

export const paymentIdParams = z.object({ id });
export const outcomeIdParams = z.object({ id });

/**
 * Recording a payment by hand (cash, check, card terminal, bank transfer...). RECEIVED (default) posts the PAYMENT ledger
 * entry at once; PENDING (a check not yet cleared) posts it when marked received.
 */
export const recordPaymentSchema = z
  .object({
    jobId: id,
    method: paymentMethodSchema,
    amountMinor: positiveMoney,
    /** Defaults to the job's currency; any other currency is refused. */
    currency: currencyCodeSchema.optional(),
    reference: text(120).optional(),
    status: z.enum(["RECEIVED", "PENDING"]).default("RECEIVED"),
    /** When the money arrived (RECEIVED only); defaults to now, never in the future. */
    receivedAt: instant.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (METHODS_NEEDING_REFERENCE.has(value.method) && !value.reference) {
      context.addIssue({ code: "custom", path: ["reference"], message: "A reference is required for this payment method" });
    }
    if (value.status === "PENDING" && value.receivedAt) {
      context.addIssue({ code: "custom", path: ["receivedAt"], message: "A pending payment has not been received yet" });
    }
  });
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const markReceivedSchema = z.object({ receivedAt: instant.optional() }).strict();
export type MarkReceivedInput = z.infer<typeof markReceivedSchema>;

/** Failing (a bounced check, a declined card) or voiding (recorded by mistake) needs a reason, kept on the record and audit. */
export const reasonSchema = z.object({ reason: text(500) }).strict();
export type ReasonInput = z.infer<typeof reasonSchema>;

export const listPaymentsQuerySchema = pageQuerySchema
  .extend({
    jobId: id.optional(),
    outcomeId: id.optional(),
    status: z.enum(["PENDING", "RECEIVED", "FAILED", "VOIDED"]).optional(),
    method: paymentMethodSchema.optional(),
    origin: z.enum(["MANUAL", "PROVIDER"]).optional(),
  })
  .strict();
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

/**
 * Confirming the charge of an outcome. `expectedAmountMinor` is the amount the confirmer saw in the queue: if the outcome
 * was corrected in between, the confirmation is refused (409 `revenue.outcome_changed`) instead of posting a number nobody
 * looked at.
 */
export const confirmChargeSchema = z.object({ expectedAmountMinor: positiveMoney }).strict();
export type ConfirmChargeInput = z.infer<typeof confirmChargeSchema>;

/** Confirming the collection the technician reported. `method` defaults to the outcome's; `reference` as for manual payments. */
export const confirmCollectionSchema = z
  .object({ expectedAmountMinor: positiveMoney, method: paymentMethodSchema.optional(), reference: text(120).optional() })
  .strict();
export type ConfirmCollectionInput = z.infer<typeof confirmCollectionSchema>;

export const chargesToConfirmQuerySchema = pageQuerySchema
  .extend({
    /** `pending` (default): outcomes with a charge or a collection not yet posted. `all`: every SOLD outcome with money. */
    state: z.enum(["pending", "all"]).default("pending"),
    jobId: id.optional(),
  })
  .strict();
export type ChargesToConfirmQuery = z.infer<typeof chargesToConfirmQuerySchema>;

/** Provider keys are short lowercase identifiers (they are stored on every intake event). */
export const PROVIDER_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const intakeParams = z.object({ tenantSlug: z.string().trim().min(1).max(100), provider: z.string().regex(PROVIDER_KEY) });

export const listIntakeEventsQuerySchema = pageQuerySchema
  .extend({
    provider: z.string().regex(PROVIDER_KEY).optional(),
    status: z.enum(["RECEIVED", "ACCEPTED", "REJECTED", "DUPLICATE", "UNMATCHED"]).optional(),
  })
  .strict();
export type ListIntakeEventsQuery = z.infer<typeof listIntakeEventsQuerySchema>;
