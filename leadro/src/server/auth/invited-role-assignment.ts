import type { ScopeType } from "@prisma/client";
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
 * Grants the invited role WITH its data scope. This is the one place auth creates a role
 * assignment; once the authorization engine exposes `assignRole`, repoint this function at it.
 * A role assignment without a scope would grant nothing, which is why invitations must carry one.
 */
export async function createInvitedRoleAssignment(
  tx: TenantTx,
  params: { tenantId: string; userId: string; roleId: string; scope: InvitationScope; grantedById: string | null },
): Promise<void> {
  const assignment = await tx.roleAssignment.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      roleId: params.roleId,
      grantedById: params.grantedById,
      reason: "Granted by invitation",
    },
    select: { id: true },
  });
  await tx.accessScope.create({
    data: {
      tenantId: params.tenantId,
      roleAssignmentId: assignment.id,
      type: params.scope.type,
      legalEntityId: params.scope.type === "LEGAL_ENTITY" ? params.scope.legalEntityId : null,
      orgUnitId: params.scope.type === "ORG_UNIT" ? params.scope.orgUnitId : null,
      includeDescendants: params.scope.includeDescendants ?? true,
    },
  });
}
