import type { Prisma } from "@prisma/client";
import { baseFieldMap, type FieldMap } from "@/server/authz";

/**
 * Outcome fields returned by the API. Outcomes have no sensitive field set: the technician who reports
 * the amounts and everyone who may view outcomes sees them (money is part of what a visit outcome IS).
 * Every stored column except `tenantId` is listed on purpose; a new column stays hidden until added here.
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

export const OUTCOME_FIELD_MAP: FieldMap = baseFieldMap(Object.keys(OUTCOME_COLUMNS));

export const outcomeRowSelect = OUTCOME_COLUMNS;
export type OutcomeRow = Prisma.JobOutcomeGetPayload<{ select: typeof OUTCOME_COLUMNS }>;
