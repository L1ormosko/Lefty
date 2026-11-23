import type { Prisma } from "@prisma/client";
import { JOB_OUTCOME_FIELD_MAP, type FieldMap } from "@/server/authz";

/**
 * Outcome columns returned by the API. `JOB_OUTCOME_FIELD_MAP` (authz) classifies each: amounts, currency and payment
 * are the opt-in `financial` set. A new column stays hidden until it is classified there.
 */
export const OUTCOME_COLUMNS = {
  id: true,
  jobId: true,
  visitNumber: true,
  employeeId: true,
  outcome: true,
  lostReasonId: true,
  notes: true,
  quotedAmountMinor: true,
  approvedAmountMinor: true,
  chargedAmountMinor: true,
  collectedAmountMinor: true,
  currency: true,
  paymentMethod: true,
  paymentStatus: true,
  customerRequestedFollowUp: true,
  preferredFollowUpAt: true,
  occurredAt: true,
  recordedAt: true,
  recordedById: true,
  clientEventId: true,
} satisfies Prisma.JobOutcomeSelect;

export const OUTCOME_FIELD_MAP: FieldMap = JOB_OUTCOME_FIELD_MAP;

/** Columns of the `financial` set: sending or changing any of them needs that set in the caller's grant. */
export const OUTCOME_FINANCIAL_KEYS: readonly string[] = Object.entries(JOB_OUTCOME_FIELD_MAP)
  .filter(([, tag]) => tag === "financial")
  .map(([key]) => key);

export const outcomeRowSelect = OUTCOME_COLUMNS;
export type OutcomeRow = Prisma.JobOutcomeGetPayload<{ select: typeof OUTCOME_COLUMNS }>;
