import { holdsMfaRequiringRole } from "@/server/authz";
import type { TenantTx } from "@/server/db";

/**
 * Does this user have to pass an MFA challenge to log in? Yes when ANY currently active role
 * assignment points at an active role with `requiresMfa` (§22.1 "MFA for sensitive roles").
 *
 * What counts as an "active assignment" is decided in ONE place, the authorization module
 * (`holdsMfaRequiringRole`), so login and access checks can never disagree about it.
 */
export function userRequiresMfa(tx: TenantTx, tenantId: string, userId: string, now = new Date()): Promise<boolean> {
  return holdsMfaRequiringRole(tx, tenantId, userId, now);
}
