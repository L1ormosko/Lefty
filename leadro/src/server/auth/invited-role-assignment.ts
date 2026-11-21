import type { ScopeType } from "@prisma/client";
import { assertMayGrantRole, assignRole, bootstrapRoleAssignment } from "@/server/authz";
import { ValidationError } from "@/server/core";
import type { TenantTx } from "@/server/db";

/** The data scope an invitation grants together with its role (§4.2 ABAC). */
export interface InvitationScope {
  type: ScopeType;
  /** Required for `LEGAL_ENTITY`. */
  legalEntityId?: string;
  /** Required for `ORG_UNIT`. */
  orgUnitId?: string;
  includeDescendants?: boolean;
}

/**
 * Checks that a scope is well-formed and that its targets exist in the tenant, so a bad id is a
 * clean validation error instead of a database failure later.
 * @throws ValidationError (field `scope`)
 */
export async function assertInvitationScopeIsValid(tx: TenantTx, tenantId: string, scope: InvitationScope): Promise<void> {
  const fail = (message: string): never => {
    throw new ValidationError({ message, field: "scope" });
  };
  if (scope.type === "ORG_UNIT") {
    if (!scope.orgUnitId) fail("An ORG_UNIT scope needs an orgUnitId.");
    const unit = await tx.orgUnit.findFirst({ where: { id: scope.orgUnitId, tenantId }, select: { id: true } });
    if (!unit) fail("The scope's org unit does not exist.");
  } else if (scope.type === "LEGAL_ENTITY") {
    if (!scope.legalEntityId) fail("A LEGAL_ENTITY scope needs a legalEntityId.");
    const entity = await tx.legalEntity.findFirst({ where: { id: scope.legalEntityId, tenantId }, select: { id: true } });
    if (!entity) fail("The scope's legal entity does not exist.");
  }
}

/**
 * Accept time (T3 minor): the scope's target must still exist AND still be active. A tenant-wide
 * inviter could technically grant over an archived unit, but that would create an assignment that
 * silently grants nothing, so the invitation is treated as dead instead.
 * @throws ValidationError (field `scope`)
 */
async function assertScopeTargetStillActive(tx: TenantTx, tenantId: string, scope: InvitationScope): Promise<void> {
  const dead = () => new ValidationError({ message: "The invitation's scope target is no longer available.", field: "scope" });
  if (scope.type === "ORG_UNIT") {
    const unit = await tx.orgUnit.findFirst({ where: { id: scope.orgUnitId ?? "", tenantId }, select: { active: true } });
    if (!unit?.active) throw dead();
  } else if (scope.type === "LEGAL_ENTITY") {
    const entity = await tx.legalEntity.findFirst({ where: { id: scope.legalEntityId ?? "", tenantId }, select: { active: true } });
    if (!entity?.active) throw dead();
  }
}

const toScopeInputs = (scope: InvitationScope) => [
  {
    type: scope.type,
    legalEntityId: scope.type === "LEGAL_ENTITY" ? scope.legalEntityId : undefined,
    orgUnitId: scope.type === "ORG_UNIT" ? scope.orgUnitId : undefined,
    includeDescendants: scope.includeDescendants ?? true,
  },
];

/**
 * Invitation CREATE time: the inviter must be allowed to hand out this role over this scope to
 * this person, by the very same anti-escalation rules as `assignRole` (a dry run, nothing is
 * written). Without it an administrator could mint an invitation for a role they could never
 * grant directly.
 *
 * The invitee has no account yet, so the target is the employee record the invitation links to,
 * or (for an email that already has an INVITED user) that user's employee; with neither, the
 * target is tenant-level and needs a tenant-wide `permissions.assign`.
 *
 * @throws ForbiddenError / NotFoundError / ValidationError from authz.
 */
export async function assertInviterMayGrant(
  tx: TenantTx,
  params: { tenantId: string; inviterId: string; roleId: string; scope: InvitationScope; email: string; employeeId?: string },
): Promise<void> {
  let employeeId = params.employeeId ?? null;
  if (!employeeId) {
    const existing = await tx.user.findUnique({
      where: { tenantId_email: { tenantId: params.tenantId, email: params.email } },
      select: { employee: { select: { id: true } } },
    });
    employeeId = existing?.employee?.id ?? null;
  }
  await assertMayGrantRole(tx, { tenantId: params.tenantId, userId: params.inviterId }, {
    roleId: params.roleId,
    scopes: toScopeInputs(params.scope),
    target: { employeeId },
  });
}

/**
 * Invitation ACCEPT time: creates the role assignment through the authorization module.
 *
 * An invitation with an inviter is granted AS that inviter (`assignRole`), which re-validates their
 * authority right now: they may have lost the permission, been moved out of scope, or the scope's
 * org unit may have been archived since the invitation was created. A failed check aborts the
 * whole acceptance (the caller turns it into the generic "invalid invitation" answer).
 * The scope target is re-checked first (it may have been archived since).
 * An invitation with no inviter is a system invitation (seed/bootstrap) and uses the actor-less
 * bootstrap grant. Either way the assignment carries its explicit scope.
 *
 * Run inside the accept transaction, after the user (and employee link) exist.
 */
export async function createInvitedRoleAssignment(
  tx: TenantTx,
  params: { tenantId: string; userId: string; roleId: string; scope: InvitationScope; grantedById: string | null },
): Promise<void> {
  await assertScopeTargetStillActive(tx, params.tenantId, params.scope);
  const grant = {
    userId: params.userId,
    roleId: params.roleId,
    scopes: toScopeInputs(params.scope),
    reason: "Granted by invitation",
  };
  if (params.grantedById) {
    await assignRole(tx, { tenantId: params.tenantId, userId: params.grantedById }, grant);
  } else {
    await bootstrapRoleAssignment(tx, { ...grant, tenantId: params.tenantId });
  }
}
