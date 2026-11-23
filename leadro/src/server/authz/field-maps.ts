import { BASE_FIELD_SET } from "./conditions";
import type { FieldMap } from "./project-fields";

/**
 * Central field classification per module, so routes do not each invent one. `base` fields are
 * visible with any grant; every other tag must match a SENSITIVE_FIELD_CATEGORIES tag (checked by a
 * test). Add a column to the matching map when you add it to the model; until then it is hidden.
 */
function buildFieldMap(base: readonly string[], sensitive: Record<string, readonly string[]>): FieldMap {
  const map: FieldMap = {};
  for (const field of base) map[field] = BASE_FIELD_SET;
  for (const [tag, fields] of Object.entries(sensitive)) for (const field of fields) map[field] = tag;
  return map;
}

/**
 * Employee record fields. The financial keys are reserved for the compensation/payroll phases
 * (the Phase 1 schema has no pay columns yet); they are classified now so they can never leak by
 * default once added.
 */
export const EMPLOYEE_FIELD_MAP: FieldMap = buildFieldMap(
  [
    "id",
    "userId",
    "legalEntityId",
    "employeeNumber",
    "firstName",
    "lastName",
    "email",
    "phone",
    "jobTitle",
    "status",
    "hireDate",
    "terminationDate",
    "createdAt",
    "updatedAt",
  ],
  { financial: ["salary", "payRate", "bankAccountNumber", "bankRoutingNumber", "taxId"] },
);

/**
 * Customer record fields (the stored `Customer` columns, minus `tenantId`; a test asserts that every
 * column is classified). The billing set (`customers.billing_fields`) is opt-in.
 */
export const CUSTOMER_FIELD_MAP: FieldMap = buildFieldMap(
  [
    "id",
    "number",
    "kind",
    "name",
    "email",
    "phone",
    "phoneE164",
    "preferredLocale",
    "preferredContactChannel",
    "contactPreferences",
    "doNotContact",
    "orgUnitId",
    "archivedAt",
    "createdById",
    "createdAt",
    "updatedAt",
  ],
  { billing: ["billingName", "billingEmail", "billingAddress", "taxId", "paymentTerms", "paymentMethod"] },
);

/**
 * Lead record fields (every stored `Lead` column except `tenantId`). Leads have no sensitive set in
 * Phase 2: the quoted amount is a sales estimate, not a billing field.
 */
export const LEAD_FIELD_MAP: FieldMap = buildFieldMap(
  [
    "id",
    "number",
    "status",
    "statusChangedAt",
    "priority",
    "sourceId",
    "campaign",
    "externalId",
    "customerId",
    "contactName",
    "contactPhone",
    "contactPhoneE164",
    "contactEmail",
    "customerAddressId",
    "addressLine1",
    "addressLine2",
    "addressCity",
    "addressRegion",
    "addressPostalCode",
    "addressNormalizedKey",
    "jobTypeId",
    "serviceCategory",
    "requestedWork",
    "preferredWindowStart",
    "preferredWindowEnd",
    "preferredTimeNote",
    "notes",
    "quotedAmountMinor",
    "currency",
    "orgUnitId",
    "nextFollowUpAt",
    "duplicateOfLeadId",
    "closedReason",
    "archivedAt",
    "createdById",
    "createdAt",
    "updatedAt",
  ],
  {},
);

/**
 * Job record fields (every stored `Job` column except `tenantId`). Money (`quotedAmountMinor`,
 * `currency`) is the `financial` set (`jobs.financial_fields`): opt-in, so Dispatchers and
 * Technicians (plain grants) never receive it.
 */
export const JOB_FIELD_MAP: FieldMap = buildFieldMap(
  [
    "id",
    "number",
    "customerId",
    "serviceAddressId",
    "jobTypeId",
    "orgUnitId",
    "leadId",
    "parentJobId",
    "origin",
    "status",
    "statusChangedAt",
    "priority",
    "title",
    "description",
    "instructions",
    "appointmentWindowStart",
    "appointmentWindowEnd",
    "scheduledStartAt",
    "scheduledEndAt",
    "timeZone",
    "estimatedDurationMinutes",
    "currentVisitNumber",
    "enRouteAt",
    "arrivedAt",
    "startedAt",
    "completedAt",
    "closedAt",
    "cancelledAt",
    "statusReason",
    "archivedAt",
    "createdById",
    "createdAt",
    "updatedAt",
  ],
  { financial: ["quotedAmountMinor", "currency"] },
);

/**
 * Location event fields (every stored `LocationEvent` column except `tenantId`). Raw coordinates are the
 * opt-in `coordinates` set (`location.coordinate_fields`, spec 22.2): a plain `location.view` grant sees
 * when, what kind, how accurate and what the server concluded, never where.
 */
export const LOCATION_EVENT_FIELD_MAP: FieldMap = buildFieldMap(
  [
    "id",
    "employeeId",
    "shiftId",
    "jobId",
    "orgUnitId",
    "kind",
    "source",
    "verification",
    "accuracyM",
    "distanceToJobM",
    "geofenceRadiusM",
    "deviceTime",
    "serverTime",
    "deviceId",
    "exception",
    "exceptionNote",
    "coordinatesPurgedAt",
    "recordedByUserId",
    "fieldEventId",
  ],
  { coordinates: ["latitude", "longitude"] },
);

/**
 * Field map for records that have no sensitive field sets (users, org units, roles, ...): every
 * listed field is `base`. Unlisted fields stay hidden, so a new column must be added here on purpose.
 */
export const baseFieldMap = (fields: readonly string[]): FieldMap => buildFieldMap(fields, {});
