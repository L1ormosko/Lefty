import { z } from "zod";
import { ADJUSTMENT_REASON_CODES } from "@/lib/finance-correction-rules";
import { currencyCodeSchema, moneyAmountSchema, signedMoneyAmountSchema } from "@/lib/money";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of `/api/v1/finance/(refunds|chargebacks|adjustments|review-flags)/**`. Every body is `.strict()`. */

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const positiveMoney = moneyAmountSchema.refine((amount) => amount > 0n, "Must be greater than zero");
/** Card-network style reason codes ("10.4", "fraud", "4837"). */
const networkReasonCode = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/, "a short code (letters, digits, . _ -)");

export const financeIdParams = z.object({ id });

// ── Refunds ──
/** A refund is always against one RECEIVED payment; partial refunds are allowed up to what is left of it. */
export const requestRefundSchema = z
  .object({
    paymentId: id,
    amountMinor: positiveMoney,
    /** Defaults to the payment's currency; another currency is refused. */
    currency: currencyCodeSchema.optional(),
    reason: text(1000),
  })
  .strict();
export type RequestRefundInput = z.infer<typeof requestRefundSchema>;

/** The refund was paid out (cash handed back, card refund issued at the terminal...): posts the REFUND entry. */
export const completeRefundSchema = z
  .object({
    /** When the money went back; defaults to now, never in the future. */
    refundedAt: instant.optional(),
    /** The terminal slip, bank or provider reference of the payout. */
    reference: text(200).optional(),
  })
  .strict();
export type CompleteRefundInput = z.infer<typeof completeRefundSchema>;

export const reasonSchema = z.object({ reason: text(1000) }).strict();
export type ReasonInput = z.infer<typeof reasonSchema>;

const REFUND_STATUSES = ["REQUESTED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CANCELLED"] as const;
export const listRefundsQuerySchema = pageQuerySchema
  .extend({ jobId: id.optional(), paymentId: id.optional(), status: z.enum(REFUND_STATUSES).optional() })
  .strict();
export type ListRefundsQuery = z.infer<typeof listRefundsQuerySchema>;

// ── Adjustments ──
/**
 * A credit (negative: the customer owes less) or a debit (positive: owes more) on a job, with a reason. There is no
 * employee field on purpose: an adjustment never deducts from wages or changes commission (spec 11.7, 28.4).
 */
export const requestAdjustmentSchema = z
  .object({
    jobId: id,
    amountMinor: signedMoneyAmountSchema.refine((amount) => amount !== 0n, "An adjustment is never zero"),
    currency: currencyCodeSchema.optional(),
    reasonCode: z.enum(ADJUSTMENT_REASON_CODES),
    reason: text(1000),
    /** The outcome the adjustment corrects, when there is one (must belong to the job). */
    outcomeId: id.optional(),
  })
  .strict();
export type RequestAdjustmentInput = z.infer<typeof requestAdjustmentSchema>;

const ADJUSTMENT_STATUSES = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CANCELLED"] as const;
export const listAdjustmentsQuerySchema = pageQuerySchema
  .extend({ jobId: id.optional(), status: z.enum(ADJUSTMENT_STATUSES).optional(), reasonCode: z.string().trim().max(50).optional() })
  .strict();
export type ListAdjustmentsQuery = z.infer<typeof listAdjustmentsQuerySchema>;

// ── Chargebacks ──
/** A chargeback recorded by hand (the processor's letter or portal), against one RECEIVED payment. */
export const recordChargebackSchema = z
  .object({
    paymentId: id,
    amountMinor: positiveMoney,
    currency: currencyCodeSchema.optional(),
    reasonCode: networkReasonCode.optional(),
    notes: text(2000).optional(),
    /** When the processor opened it; defaults to now, never in the future. */
    openedAt: instant.optional(),
  })
  .strict();
export type RecordChargebackInput = z.infer<typeof recordChargebackSchema>;

export const chargebackNotesSchema = z.object({ notes: text(2000).optional() }).strict();
export type ChargebackNotesInput = z.infer<typeof chargebackNotesSchema>;

const CHARGEBACK_STATUSES = ["OPEN", "DISPUTED", "WON", "LOST", "WRITE_OFF_PENDING_APPROVAL", "WRITTEN_OFF"] as const;
export const listChargebacksQuerySchema = pageQuerySchema
  .extend({ jobId: id.optional(), paymentId: id.optional(), status: z.enum(CHARGEBACK_STATUSES).optional() })
  .strict();
export type ListChargebacksQuery = z.infer<typeof listChargebacksQuerySchema>;

// ── Finance review flags ──
/** A person flags a job (and optionally one of its money records) for finance review. */
export const raiseFlagSchema = z
  .object({
    jobId: id,
    note: text(2000),
    paymentId: id.optional(),
    refundId: id.optional(),
    chargebackId: id.optional(),
    adjustmentId: id.optional(),
    ledgerEntryId: id.optional(),
  })
  .strict();
export type RaiseFlagInput = z.infer<typeof raiseFlagSchema>;

export const assignFlagSchema = z.object({ assigneeUserId: id }).strict();
export type AssignFlagInput = z.infer<typeof assignFlagSchema>;

export const resolveFlagSchema = z.object({ resolutionReason: text(2000) }).strict();
export type ResolveFlagInput = z.infer<typeof resolveFlagSchema>;

export const listFlagsQuerySchema = pageQuerySchema
  .extend({
    status: z.enum(["OPEN", "ASSIGNED", "RESOLVED"]).optional(),
    jobId: id.optional(),
    assignedToId: id.optional(),
    reasonCode: z.string().trim().max(100).optional(),
  })
  .strict();
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;
