import { z } from "zod";
import { moneyAmountSchema } from "@/lib/money";
import { JOB_OUTCOME_TYPES } from "@/lib/job-outcome-rules";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the job outcomes and lost reasons API. Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
/** §11.8: money is integer minor units, never a float. */
const money = moneyAmountSchema;
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "ISO 4217 code");

export const outcomeTypeSchema = z.enum(JOB_OUTCOME_TYPES);
const paymentMethod = z.enum(["CASH", "CARD", "CHECK", "BANK_TRANSFER", "FINANCING", "OTHER"]);
const paymentStatus = z.enum(["NOT_APPLICABLE", "PENDING", "PARTIAL", "PAID", "WAIVED", "REFUSED"]);

export const jobIdParams = z.object({ id });
export const outcomeIdParams = z.object({ id });
export const lostReasonIdParams = z.object({ id });

/**
 * Reporting the outcome of the job's current visit (§9.1). `clientEventId` + `occurredAt` are the
 * offline envelope (§8.7): a replay with the same id and content returns the first result.
 */
export const recordOutcomeSchema = z
  .object({
    outcome: outcomeTypeSchema,
    lostReasonId: id.optional(),
    notes: text(4000).optional(),
    quotedAmountMinor: money.optional(),
    approvedAmountMinor: money.optional(),
    chargedAmountMinor: money.optional(),
    collectedAmountMinor: money.optional(),
    /** Defaults to the job's currency. */
    currency: currency.optional(),
    paymentMethod: paymentMethod.optional(),
    paymentStatus: paymentStatus.optional(),
    customerRequestedFollowUp: z.boolean().optional(),
    preferredFollowUpAt: instant.optional(),
    clientEventId: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
    occurredAt: instant.optional(),
  })
  .strict();
export type RecordOutcomeInput = z.infer<typeof recordOutcomeSchema>;

/** Correcting a recorded outcome (`job_outcomes.edit`). The outcome type itself never changes: the job status already followed it. `null` clears a value. */
export const correctOutcomeSchema = z
  .object({
    /** Why the record is corrected; kept in the audit trail. */
    reason: text(500),
    lostReasonId: id.nullable().optional(),
    notes: text(4000).nullable().optional(),
    quotedAmountMinor: money.nullable().optional(),
    approvedAmountMinor: money.nullable().optional(),
    chargedAmountMinor: money.nullable().optional(),
    collectedAmountMinor: money.nullable().optional(),
    currency: currency.optional(),
    paymentMethod: paymentMethod.nullable().optional(),
    paymentStatus: paymentStatus.optional(),
    customerRequestedFollowUp: z.boolean().optional(),
    preferredFollowUpAt: instant.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "reason"), { message: "Nothing to change" });
export type CorrectOutcomeInput = z.infer<typeof correctOutcomeSchema>;

const boolQuery = z.enum(["true", "false"]).transform((value) => value === "true");

export const listOutcomesQuerySchema = pageQuerySchema.extend({
  jobId: id.optional(),
  outcome: outcomeTypeSchema.optional(),
  lostReasonId: id.optional(),
  employeeId: id.optional(),
  customerRequestedFollowUp: boolQuery.optional(),
  occurredFrom: instant.optional(),
  occurredTo: instant.optional(),
});
export type ListOutcomesQuery = z.infer<typeof listOutcomesQuerySchema>;

// ─────────────────────────── Lost reasons (§9.2) ───────────────────────────

const lostReasonCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "Lower-case letters, digits, '-' and '_'");
const appliesTo = z.array(outcomeTypeSchema).min(1).max(JOB_OUTCOME_TYPES.length).transform((values) => [...new Set(values)]);

export const createLostReasonSchema = z
  .object({
    code: lostReasonCode,
    name: text(120),
    description: text(500).optional(),
    appliesTo: appliesTo.default(["NOT_SOLD", "WORK_NOT_POSSIBLE"]),
    /** False for reasons recovery can do nothing about (e.g. outside the company's services). */
    recoverable: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type CreateLostReasonInput = z.infer<typeof createLostReasonSchema>;

/** `code` never changes (reports and rules refer to it); retire a reason with `active: false`, never delete. */
export const updateLostReasonSchema = z
  .object({
    name: text(120).optional(),
    description: text(500).nullable().optional(),
    appliesTo: appliesTo.optional(),
    recoverable: z.boolean().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });
export type UpdateLostReasonInput = z.infer<typeof updateLostReasonSchema>;

export const listLostReasonsQuerySchema = z.object({
  /** Inactive reasons are hidden unless asked for (settings screens ask; the technician's picker does not). */
  includeInactive: boolQuery.optional(),
  /** Only reasons that apply to this outcome (the picker of the outcome the technician chose). */
  outcome: outcomeTypeSchema.optional(),
});
export type ListLostReasonsQuery = z.infer<typeof listLostReasonsQuerySchema>;
