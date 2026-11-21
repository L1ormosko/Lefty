import { ForbiddenError, NotFoundError } from "@/server/core";
import { withTenant } from "@/server/db";
import { canInTx } from "./can";
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
 * "Why can this user access this record?" (spec 4.6). Evaluates `permission` for `targetUserId`
 * against an optional record exactly like `can`, and returns the reasoning: the allowing grant, or
 * every assignment considered with the scope that did or did not match, including expired and
 * revoked ones.
 *
 * Gated here, not in the route: the diagnostic exposes a user's whole grant history, so `actor`
 * must hold `permissions.view` (else 403), and the target user (through their employee record, or
 * tenant-level for users without one) and the optional record must lie inside the actor's own
 * scope (else 404, existence not confirmed). The target is looked up in the actor's tenant only.
 */
export async function explainAccess(
  actor: AccessSubject,
  targetUserId: string,
  permission: string,
  resource?: ResourceRef,
): Promise<AccessExplanation> {
  const target: AccessSubject = { tenantId: actor.tenantId, userId: targetUserId };
  const evaluation = await withTenant(actor.tenantId, async (tx) => {
    if (!(await canInTx(tx, actor, "permissions.view")).allowed) throw new ForbiddenError();

    const user = await tx.user.findFirst({
      where: { id: targetUserId, tenantId: actor.tenantId },
      select: { employee: { select: { id: true } } },
    });
    if (!user) throw new NotFoundError();
    const targetRef: ResourceRef = user.employee ? { employeeId: user.employee.id } : {};
    if (!(await canInTx(tx, actor, "permissions.view", targetRef)).allowed) throw new NotFoundError();
    if (resource && !(await canInTx(tx, actor, "permissions.view", resource)).allowed) throw new NotFoundError();

    if (!isPermissionKey(permission)) return null;
    return evaluateAccess(tx, target, permission, resource, new Date());
  });

  if (!evaluation) {
    return {
      permission,
      decision: { allowed: false, reason: "UNKNOWN_PERMISSION", via: null, fieldSets: [] },
      accountActive: false,
      assignments: [],
      summary: REASON_SUMMARY.UNKNOWN_PERMISSION,
    };
  }

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
