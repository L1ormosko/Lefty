import { withTenant, type TenantTx } from "@/server/db";
import { conditionsAllowFieldSet } from "./conditions";
import { evaluateAccess } from "./evaluate";
import { isPermissionKey, SENSITIVE_FIELD_CATEGORIES, type FieldCategoryKey } from "./permission-catalog";
import type { AccessDecision, AccessSubject, ResourceRef } from "./types";

const UNKNOWN_PERMISSION: AccessDecision = { allowed: false, reason: "UNKNOWN_PERMISSION", via: null };

/**
 * May `subject` perform `permission` (`module.action`) — optionally on a specific record?
 *
 * - Without `resource`: a capability check ("does any active grant of this subject carry the
 *   permission?"). Use it to gate a route; list endpoints then narrow with `scopeFilter`.
 * - With `resource`: also requires the record to fall inside a data scope of the SAME role
 *   assignment that grants the permission.
 *
 * Reads the database on every call (spec 25.5). Role names never matter; only granted
 * permissions and scopes do. Unknown permission keys are denied.
 */
export async function can(
  subject: AccessSubject,
  permission: string,
  resource?: ResourceRef,
): Promise<AccessDecision> {
  if (!isPermissionKey(permission)) return UNKNOWN_PERMISSION;
  return withTenant(subject.tenantId, (tx) => canInTx(tx, subject, permission, resource));
}

/** Same as `can`, inside a transaction the caller already opened with `withTenant`. */
export async function canInTx(
  tx: TenantTx,
  subject: AccessSubject,
  permission: string,
  resource?: ResourceRef,
  now: Date = new Date(),
): Promise<AccessDecision> {
  if (!isPermissionKey(permission)) return UNKNOWN_PERMISSION;
  return (await evaluateAccess(tx, subject, permission, resource, now)).decision;
}

/**
 * May `subject` see the sensitive field set `category` (e.g. `employees.financial_fields`) of a
 * record? Requires the module's VIEW permission on the record AND a grant whose `conditions` do
 * not limit it to another field set or exclude this one (HR: no financial fields).
 */
export async function canViewFields(
  subject: AccessSubject,
  category: FieldCategoryKey,
  resource?: ResourceRef,
): Promise<AccessDecision> {
  const definition = SENSITIVE_FIELD_CATEGORIES.find((entry) => entry.key === category);
  if (!definition) return UNKNOWN_PERMISSION;
  return withTenant(subject.tenantId, async (tx) => {
    const evaluation = await evaluateAccess(tx, subject, `${definition.module}.view`, resource, new Date(), {
      conditionCheck: (conditions) => conditionsAllowFieldSet(conditions, definition.tag),
    });
    return evaluation.decision;
  });
}
