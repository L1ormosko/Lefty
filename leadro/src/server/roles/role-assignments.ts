import type { Prisma, ScopeType } from "@prisma/client";
import {
  activeAssignmentWhere,
  assignRole,
  buildScopeWhere,
  activePlacementWhere,
  enforceInTx,
  projectRows,
  resolveScope,
  revokeRoleAssignment,
  baseFieldMap,
  withinScope,
  type RowScopeAttributes,
  type ScopeColumns,
} from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { userInLegalEntities, userInOrgUnits, userOfEmployee } from "@/server/users";
import type { GrantRoleInput, ListAssignmentsQuery, RevokeAssignmentInput } from "./schemas";

/**
 * Who holds which role, over which data, for how long (§4.2). Granting and revoking go through the
 * authorization module (`assignRole`, `revokeRoleAssignment`), which enforces the anti-escalation
 * rules: not to yourself, only over scopes you administer, only roles whose permissions you hold.
 * Rows are never deleted; a revoked or expired assignment stays as history.
 */

export type AssignmentState = "ACTIVE" | "SCHEDULED" | "EXPIRED" | "REVOKED" | "ROLE_INACTIVE";

const ASSIGNMENT_FIELD_MAP = baseFieldMap([
  "id",
  "userId",
  "roleId",
  "roleName",
  "state",
  "effectiveFrom",
  "effectiveTo",
  "grantedById",
  "reason",
  "revokedAt",
  "revokedById",
  "scopes",
  "createdAt",
]);

const assignmentSelect = (now: Date) =>
  ({
    id: true,
    userId: true,
    roleId: true,
    effectiveFrom: true,
    effectiveTo: true,
    grantedById: true,
    reason: true,
    revokedAt: true,
    revokedById: true,
    createdAt: true,
    role: { select: { name: true, active: true } },
    scopes: { select: { id: true, type: true, legalEntityId: true, orgUnitId: true, includeDescendants: true } },
    user: {
      select: {
        employee: {
          select: { id: true, legalEntityId: true, assignments: { where: activePlacementWhere(now), select: { orgUnitId: true } } },
        },
      },
    },
  }) satisfies Prisma.RoleAssignmentSelect;

type AssignmentRow = Prisma.RoleAssignmentGetPayload<{ select: ReturnType<typeof assignmentSelect> }>;

function stateOf(row: AssignmentRow, now: Date): AssignmentState {
  if (row.revokedAt) return "REVOKED";
  if (row.effectiveFrom > now) return "SCHEDULED";
  if (row.effectiveTo !== null && row.effectiveTo <= now) return "EXPIRED";
  return row.role.active ? "ACTIVE" : "ROLE_INACTIVE";
}

function flatten(row: AssignmentRow, now: Date) {
  const employee = row.user.employee;
  return {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    roleName: row.role.name,
    state: stateOf(row, now),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    grantedById: row.grantedById,
    reason: row.reason,
    revokedAt: row.revokedAt,
    revokedById: row.revokedById,
    scopes: row.scopes,
    createdAt: row.createdAt,
    // not in the field map: dropped by projection, used for scope matching
    orgUnitIds: employee?.assignments.map((placement) => placement.orgUnitId) ?? [],
    legalEntityId: employee?.legalEntityId ?? null,
    employeeId: employee?.id ?? null,
  };
}

const attributesOf = (row: ReturnType<typeof flatten>): RowScopeAttributes => ({
  orgUnitIds: row.orgUnitIds,
  legalEntityIds: row.legalEntityId ? [row.legalEntityId] : [],
  ownerEmployeeId: row.employeeId,
});

/** An assignment is administered through its USER, so it is in scope exactly when that user is. */
const assignmentScopeColumns: ScopeColumns<Prisma.RoleAssignmentWhereInput> = {
  orgUnit: (orgUnitIds, now) => ({ user: userInOrgUnits(orgUnitIds, now) }),
  legalEntity: (legalEntityIds) => ({ user: userInLegalEntities(legalEntityIds) }),
  own: (employeeId) => ({ user: userOfEmployee(employeeId) }),
};

/**
 * Grants a role to a user with explicit scopes and an optional expiry (temporary access). Pure
 * delegation to authz `assignRole`, inside one transaction with its audit event (`role_assignment.grant`).
 * @throws ForbiddenError for any escalation attempt, ConflictError for a duplicate period.
 */
export async function grantRoleToUser(actor: Actor, ctx: RequestContext, input: GrantRoleInput): Promise<{ roleAssignmentId: string }> {
  return withTenant(actor.tenantId, (tx) =>
    assignRole(tx, actor, {
      userId: input.userId,
      roleId: input.roleId,
      scopes: input.scopes.map((scope) => ({ ...scope, type: scope.type as ScopeType })),
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      reason: input.reason,
      sourceApp: ctx.sourceApp,
      correlationId: ctx.correlationId,
    }),
  );
}

/** Revokes an assignment now (authority rules in authz `revokeRoleAssignment`). */
export async function revokeAssignment(
  actor: Actor,
  ctx: RequestContext,
  roleAssignmentId: string,
  input: RevokeAssignmentInput,
): Promise<void> {
  await withTenant(actor.tenantId, (tx) =>
    revokeRoleAssignment(tx, actor, {
      roleAssignmentId,
      reason: input.reason,
      sourceApp: ctx.sourceApp,
      correlationId: ctx.correlationId,
    }),
  );
}

/**
 * One page of role assignments (newest first) for users the caller may see (`permissions.view`,
 * scope = the target user's placement; users without an employee need a tenant-wide grant). By default only
 * assignments in effect now; `state=all` adds revoked, expired and scheduled ones.
 */
export async function listRoleAssignments(actor: Actor, query: ListAssignmentsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "permissions.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "permissions.view", now);
    const callerWhere: Prisma.RoleAssignmentWhereInput = {
      tenantId: actor.tenantId,
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.roleId ? { roleId: query.roleId } : {}),
      ...(query.state === "active" ? { ...activeAssignmentWhere(now), role: { active: true } } : {}),
    };
    const rows = await tx.roleAssignment.findMany({
      where: withinScope(buildScopeWhere(scope, assignmentScopeColumns, now), callerWhere),
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: assignmentSelect(now),
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data = projectRows(page.data.map((row) => flatten(row, now)), scope, ASSIGNMENT_FIELD_MAP, attributesOf);
    return { data, page: page.page };
  });
}

/** One assignment, or 404 when its user is outside the caller's scope. */
export async function getRoleAssignment(actor: Actor, roleAssignmentId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "permissions.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "permissions.view", now);
    const row = await tx.roleAssignment.findFirst({
      where: withinScope(buildScopeWhere(scope, assignmentScopeColumns, now), { id: roleAssignmentId, tenantId: actor.tenantId }),
      select: assignmentSelect(now),
    });
    if (!row) throw new NotFoundError();
    return projectRows([flatten(row, now)], scope, ASSIGNMENT_FIELD_MAP, attributesOf)[0];
  });
}
