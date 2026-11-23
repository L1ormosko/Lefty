import type { Prisma } from "@prisma/client";
import { JOB_FIELD_MAP, type FieldMap } from "@/server/authz";

/**
 * Job fields returned by the API. `JOB_FIELD_MAP` (authz) classifies every stored column (money is
 * the opt-in `financial` set); `assignments`, `requirements` and `warnings` are derived and `base`.
 * Anything not in the map is dropped by projection, so a new column must be classified on purpose.
 */
export const JOB_API_FIELD_MAP: FieldMap = { ...JOB_FIELD_MAP, assignments: "base", requirements: "base", warnings: "base" };

/** Stored columns that are returned (subject to projection); `tenantId` never leaves the server. */
export const JOB_COLUMNS = {
  id: true,
  number: true,
  customerId: true,
  serviceAddressId: true,
  jobTypeId: true,
  orgUnitId: true,
  leadId: true,
  parentJobId: true,
  origin: true,
  status: true,
  statusChangedAt: true,
  priority: true,
  title: true,
  description: true,
  instructions: true,
  appointmentWindowStart: true,
  appointmentWindowEnd: true,
  scheduledStartAt: true,
  scheduledEndAt: true,
  timeZone: true,
  estimatedDurationMinutes: true,
  currentVisitNumber: true,
  quotedAmountMinor: true,
  currency: true,
  startedAt: true,
  completedAt: true,
  closedAt: true,
  cancelledAt: true,
  statusReason: true,
  archivedAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

/** Columns plus what scope matching needs (the service-area unit's legal entity). */
export const jobRowSelect = { ...JOB_COLUMNS, orgUnit: { select: { legalEntityId: true } } } satisfies Prisma.JobSelect;

export type JobRow = Prisma.JobGetPayload<{ select: typeof jobRowSelect }>;

/** One ACTIVE assignment as the API shows it. */
export interface ActiveAssignmentView {
  id: string;
  employeeId: string | null;
  teamOrgUnitId: string | null;
  role: "LEAD" | "CREW";
  method: "MANUAL" | "RECOMMENDATION_APPROVED" | "RECOMMENDATION_MODIFIED" | "OVERRIDE";
  assignedAt: Date;
}

export interface JobRequirementView {
  skillId: string | null;
  certificationId: string | null;
  minLevel: number | null;
  source: "JOB_TYPE" | "MANUAL";
}

/** A fetched job as the API shape, before projection: the scope helper column is dropped. */
export function jobView(row: JobRow, extras: { assignments?: ActiveAssignmentView[]; requirements?: JobRequirementView[] } = {}): Record<string, unknown> {
  const { orgUnit: _orgUnit, ...columns } = row;
  return { ...columns, ...extras };
}
