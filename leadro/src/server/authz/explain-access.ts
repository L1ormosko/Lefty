import { withTenant } from "@/server/db";
import { evaluateAccess } from "./evaluate";
import type { GrantStatus } from "./load-grants";
import { isPermissionKey } from "./permission-catalog";
import type { AccessDecision, AccessSubject, ResourceRef } from "./types";

export interface ScopeExplanation {
  scopeId: string;
  type: string;
  orgUnitId: string | null;
  legalEntityId: string | null;
  includeDescendants: boolean;
  matched: boolean;
  detail: string;
}

export interface AssignmentExplanation {
  roleAssignmentId: string;
  roleName: string;
  status: GrantStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** False when the grant's conditions (record set / field set) exclude this access. */
  conditionMet: boolean;
  scopes: ScopeExplanation[];
}

export interface AccessExplanation {
  permission: string;
  decision: AccessDecision;
  /** False when the user is missing, not ACTIVE, or linked to a terminated employee. */
  accountActive: boolean;
  /** Every assignment whose role holds the permission, including expired and revoked ones. */
  assignments: AssignmentExplanation[];
  summary: string;
}

const REASON_SUMMARY: Record<string, string> = {
  USER_NOT_ACTIVE: "The user account is not active (or the employee is terminated), so no role applies.",
  UNKNOWN_PERMISSION: "The permission is not part of the permission catalog.",
  NO_PERMISSION: "No active role assignment of this user grants the permission.",
  CONDITION_NOT_MET: "A role grants the permission, but its conditions exclude this access.",
  NO_SCOPE: "A role grants the permission, but the assignment has no data scope.",
  OUT_OF_SCOPE: "A role grants the permission, but the record is outside every data scope of that assignment.",
  RESOURCE_NOT_FOUND: "The record does not exist in this tenant.",
};

/**
 * "Why can this user access this record?" (spec 4.6). Evaluates `permission` for `subject` against
 * an optional record exactly like `can`, and returns the reasoning: the allowing grant, or every
 * assignment considered with the scope that did or did not match, including expired and revoked
 * ones. The route exposing it must itself require `permissions.view`.
 */
export async function explainAccess(
  subject: AccessSubject,
  permission: string,
  resource?: ResourceRef,
): Promise<AccessExplanation> {
  if (!isPermissionKey(permission)) {
    return {
      permission,
      decision: { allowed: false, reason: "UNKNOWN_PERMISSION", via: null },
      accountActive: false,
      assignments: [],
      summary: REASON_SUMMARY.UNKNOWN_PERMISSION,
    };
  }
  const evaluation = await withTenant(subject.tenantId, (tx) =>
    evaluateAccess(tx, subject, permission, resource, new Date()),
  );

  const assignments: AssignmentExplanation[] = evaluation.grants.map((grant) => {
    const evaluated = evaluation.evaluations.find((entry) => entry.grant.roleAssignmentId === grant.roleAssignmentId);
    return {
      roleAssignmentId: grant.roleAssignmentId,
      roleName: grant.roleName,
      status: grant.status,
      effectiveFrom: grant.effectiveFrom,
      effectiveTo: grant.effectiveTo,
      conditionMet: evaluated?.conditionMet ?? false,
      scopes: grant.scopes.map((scope) => {
        const result = evaluated?.scopes.find((entry) => entry.scope.id === scope.id);
        return {
          scopeId: scope.id,
          type: scope.type,
          orgUnitId: scope.orgUnitId,
          legalEntityId: scope.legalEntityId,
          includeDescendants: scope.includeDescendants,
          matched: result?.matched ?? false,
          detail: result?.detail ?? (grant.status === "ACTIVE" ? "Not evaluated." : `Assignment is ${grant.status}; ignored.`),
        };
      }),
    };
  });

  const { decision } = evaluation;
  const summary =
    decision.allowed && decision.via
      ? `Granted by role "${decision.via.roleName}" through a ${decision.via.scopeType} scope.`
      : (REASON_SUMMARY[decision.reason] ?? "Access denied.");

  return { permission, decision, accountActive: evaluation.subject.isActive, assignments, summary };
}
