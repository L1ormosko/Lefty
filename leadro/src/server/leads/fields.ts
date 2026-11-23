import type { Prisma } from "@prisma/client";
import { LEAD_FIELD_MAP, type FieldMap } from "@/server/authz";

/**
 * Lead fields returned by the API. `LEAD_FIELD_MAP` (authz) classifies every stored column (all `base`:
 * leads have no sensitive set); `assignedEmployeeId` is derived from the ACTIVE `LeadAssignment` and is base
 * data too. Anything not in the map is dropped by projection (fail closed).
 */
export const LEAD_API_FIELD_MAP: FieldMap = { ...LEAD_FIELD_MAP, assignedEmployeeId: "base", nextStatuses: "base" };

/** Stored columns that are returned (subject to projection); `tenantId` never leaves the server. */
export const LEAD_COLUMNS = {
  id: true,
  number: true,
  status: true,
  statusChangedAt: true,
  priority: true,
  sourceId: true,
  campaign: true,
  externalId: true,
  customerId: true,
  contactName: true,
  contactPhone: true,
  contactPhoneE164: true,
  contactEmail: true,
  customerAddressId: true,
  addressLine1: true,
  addressLine2: true,
  addressCity: true,
  addressRegion: true,
  addressPostalCode: true,
  addressNormalizedKey: true,
  jobTypeId: true,
  serviceCategory: true,
  requestedWork: true,
  preferredWindowStart: true,
  preferredWindowEnd: true,
  preferredTimeNote: true,
  notes: true,
  quotedAmountMinor: true,
  currency: true,
  orgUnitId: true,
  nextFollowUpAt: true,
  duplicateOfLeadId: true,
  closedReason: true,
  archivedAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

/** Columns plus what scope matching needs (the legal entity of the unit). */
export const leadRowSelect = {
  ...LEAD_COLUMNS,
  orgUnit: { select: { legalEntityId: true } },
} satisfies Prisma.LeadSelect;

export type LeadRow = Prisma.LeadGetPayload<{ select: typeof leadRowSelect }>;

/** The record as the API shows it before projection: the columns plus the current owner. */
export function leadView(row: LeadRow, assignedEmployeeId: string | null): Record<string, unknown> {
  const { orgUnit: _orgUnit, ...columns } = row;
  return { ...columns, assignedEmployeeId };
}
