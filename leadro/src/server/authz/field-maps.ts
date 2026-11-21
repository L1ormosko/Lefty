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

/** Customer record fields; billing keys are reserved for the customers module. */
export const CUSTOMER_FIELD_MAP: FieldMap = buildFieldMap(
  ["id", "name", "email", "phone", "address", "status", "createdAt", "updatedAt"],
  { billing: ["billingAddress", "billingEmail", "paymentMethod", "taxId"] },
);
