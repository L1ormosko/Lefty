import type { ScopeType } from "@prisma/client";
import type { Actor } from "@/server/core";

/** Who is being evaluated. An `Actor` satisfies it; diagnostics pass just a user id. */
export type AccessSubject = Pick<Actor, "tenantId" | "userId">;

/**
 * Attributes of the record being accessed. The resolver that builds this MUST read them from the
 * database (inside the caller's tenant), never copy them from the request body: the scope check is
 * only as trustworthy as these values.
 *
 * - `{}` (no attributes) describes a tenant-level record with no org placement (audit log, company
 *   settings): only TENANT scopes match it.
 * - Passing no resource at all means "may this subject ever do this?" (a capability check).
 */
export interface ResourceRef {
  /** The record belongs to this org unit. */
  orgUnitId?: string;
  /** The record is this employee's. Org units and legal employer are derived from the employee's
   *  active placements; the employee also counts as the owner unless `ownerEmployeeId` is given. */
  employeeId?: string;
  legalEntityId?: string;
  /** Employee that owns the record (OWN scope): their statement, their shift. */
  ownerEmployeeId?: string;
  /** Employees the record is assigned to (ASSIGNED scope): a job's crew. */
  assignedEmployeeIds?: string[];
  /** Record-set qualifiers this record belongs to (e.g. "job_related"), matched against a grant's
   *  `conditions.set`. */
  sets?: string[];
}

export type AccessReason =
  | "GRANTED"
  /** User is missing, not ACTIVE, or linked to a TERMINATED employee. */
  | "USER_NOT_ACTIVE"
  | "UNKNOWN_PERMISSION"
  /** No active role assignment grants the permission. */
  | "NO_PERMISSION"
  /** A grant exists but its conditions (record set / field set) do not allow this access. */
  | "CONDITION_NOT_MET"
  /** The active assignment carries no data scope, so it covers no records. */
  | "NO_SCOPE"
  | "OUT_OF_SCOPE"
  /** The referenced record does not exist in the subject's tenant (also what forged ids look like). */
  | "RESOURCE_NOT_FOUND";

/** The grant that allowed the access (spec 4.6 "why can this user access this record?"). */
export interface AccessVia {
  roleAssignmentId: string;
  roleId: string;
  roleName: string;
  requiresMfa: boolean;
  scopeId: string;
  scopeType: ScopeType;
  scopeOrgUnitId: string | null;
  scopeLegalEntityId: string | null;
}

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
  via: AccessVia | null;
  /**
   * Field sets the subject may see or change on the record, unioned over every grant that matched:
   * `base` (all non-sensitive fields), sensitive sets such as `financial`, or a limited set such as
   * `availability`. Empty when denied. ROUTES MUST PROJECT THE RESPONSE FROM IT (`projectFields`):
   * `allowed: true` on a field-limited grant does not mean the whole record may be returned.
   */
  fieldSets: string[];
}
