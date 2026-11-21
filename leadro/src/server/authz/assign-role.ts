import type { ScopeType } from "@prisma/client";
import { recordAudit } from "@/server/audit";
import { ConflictError, NotFoundError, ValidationError, type SourceApp } from "@/server/core";
import type { TenantTx } from "@/server/db";

export interface ScopeInput {
  type: ScopeType;
  /** Required for LEGAL_ENTITY, forbidden otherwise. */
  legalEntityId?: string;
  /** Required for ORG_UNIT, forbidden otherwise. */
  orgUnitId?: string;
  /** ORG_UNIT only; defaults to true. */
  includeDescendants?: boolean;
}

export interface AssignRoleInput {
  tenantId: string;
  userId: string;
  roleId: string;
  /** At least one: an assignment without a scope would grant access to nothing. */
  scopes: ScopeInput[];
  effectiveFrom?: Date;
  /** Temporary access: the assignment stops counting at this instant. */
  effectiveTo?: Date;
  grantedById?: string;
  reason?: string;
  sourceApp?: SourceApp;
  correlationId?: string;
}

const scopeKey = (scope: { type: ScopeType; legalEntityId?: string | null; orgUnitId?: string | null; includeDescendants?: boolean }) =>
  [
    scope.type,
    scope.legalEntityId ?? "",
    scope.orgUnitId ?? "",
    scope.type === "ORG_UNIT" ? String(scope.includeDescendants ?? true) : "",
  ].join("|");

/** Mirrors the `access_scope_target` CHECK so callers get a clean 400 instead of a database error. */
function validateScopes(scopes: ScopeInput[]): void {
  if (scopes.length === 0) throw new ValidationError({ message: "A role assignment needs at least one scope.", field: "scopes" });
  for (const scope of scopes) {
    const needsEntity = scope.type === "LEGAL_ENTITY";
    const needsUnit = scope.type === "ORG_UNIT";
    if (needsEntity !== (scope.legalEntityId !== undefined) || needsUnit !== (scope.orgUnitId !== undefined)) {
      throw new ValidationError({
        message: `Scope ${scope.type} has the wrong target: LEGAL_ENTITY needs legalEntityId, ORG_UNIT needs orgUnitId, others need neither.`,
        field: "scopes",
      });
    }
  }
}

const overlaps = (aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): boolean =>
  aFrom < (bTo ?? new Date(8.64e15)) && bFrom < (aTo ?? new Date(8.64e15));

/**
 * Grants `roleId` to a user with the given data scopes and optional validity window, and audits it.
 *
 * Duplicate guard (T1 review): the same (user, role, scope) must not be active twice over
 * overlapping periods. This is a SERVICE check, not a database constraint, because scopes live in a
 * child table (`AccessScope`) so a plain unique/exclusion constraint on `RoleAssignment` cannot see
 * them, and forbidding any second (user, role) row would block legitimate temporary extra scopes.
 * A per-(tenant, user) advisory lock serialises concurrent grants so two requests cannot both pass
 * the check. Revoked assignments never conflict.
 *
 * Run inside `withTenant(tenantId, tx => ...)`.
 *
 * @throws ValidationError for malformed scopes or dates, NotFoundError for an unknown
 *   user/role/org unit/legal entity in this tenant, ConflictError for a duplicate.
 */
export async function assignRole(tx: TenantTx, input: AssignRoleInput): Promise<{ roleAssignmentId: string }> {
  const effectiveFrom = input.effectiveFrom ?? new Date();
  const effectiveTo = input.effectiveTo ?? null;
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    throw new ValidationError({ message: "effectiveTo must be after effectiveFrom.", field: "effectiveTo" });
  }
  validateScopes(input.scopes);

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`role-assignment:${input.tenantId}:${input.userId}`}))`;

  const [user, role] = await Promise.all([
    tx.user.findFirst({ where: { id: input.userId, tenantId: input.tenantId }, select: { id: true } }),
    tx.role.findFirst({ where: { id: input.roleId, tenantId: input.tenantId }, select: { id: true } }),
  ]);
  if (!user || !role) throw new NotFoundError({ message: "The user or role was not found." });

  const unitIds = input.scopes.flatMap((s) => (s.orgUnitId ? [s.orgUnitId] : []));
  const entityIds = input.scopes.flatMap((s) => (s.legalEntityId ? [s.legalEntityId] : []));
  const [unitCount, entityCount] = await Promise.all([
    tx.orgUnit.count({ where: { tenantId: input.tenantId, id: { in: unitIds } } }),
    tx.legalEntity.count({ where: { tenantId: input.tenantId, id: { in: entityIds } } }),
  ]);
  if (unitCount !== new Set(unitIds).size || entityCount !== new Set(entityIds).size) {
    throw new NotFoundError({ message: "A scope target was not found." });
  }

  const sameRole = await tx.roleAssignment.findMany({
    where: { tenantId: input.tenantId, userId: input.userId, roleId: input.roleId, revokedAt: null },
    select: { effectiveFrom: true, effectiveTo: true, scopes: { select: { type: true, legalEntityId: true, orgUnitId: true, includeDescendants: true } } },
  });
  const requested = new Set(input.scopes.map(scopeKey));
  const duplicate = sameRole.some(
    (existing) =>
      overlaps(existing.effectiveFrom, existing.effectiveTo, effectiveFrom, effectiveTo) &&
      existing.scopes.some((scope) => requested.has(scopeKey(scope))),
  );
  if (duplicate) {
    throw new ConflictError({ message: "This user already holds this role with the same scope for an overlapping period." });
  }

  const created = await tx.roleAssignment.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      roleId: input.roleId,
      effectiveFrom,
      effectiveTo,
      grantedById: input.grantedById,
      reason: input.reason,
      scopes: {
        // tenantId is shared with the parent row's composite key and filled in by Prisma.
        create: input.scopes.map((scope) => ({
          type: scope.type,
          legalEntityId: scope.legalEntityId,
          orgUnitId: scope.orgUnitId,
          includeDescendants: scope.includeDescendants ?? true,
        })),
      },
    },
    select: { id: true },
  });

  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorUserId: input.grantedById ?? null,
    action: "role_assignment.grant",
    targetType: "RoleAssignment",
    targetId: created.id,
    newValue: {
      userId: input.userId,
      roleId: input.roleId,
      scopes: input.scopes,
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveTo: effectiveTo?.toISOString() ?? null,
    },
    reason: input.reason,
    sourceApp: input.sourceApp ?? "SYSTEM",
    correlationId: input.correlationId,
  });

  return { roleAssignmentId: created.id };
}
