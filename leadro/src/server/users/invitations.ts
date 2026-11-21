import type { Prisma } from "@prisma/client";
import { buildScopeWhere, employeeScopeColumns, enforceInTx, resolveScope, withinScope } from "@/server/authz";
import { pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";

export type InvitationState = "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";

/** An invitation as the Users screen shows it. The token and its hash are never selected. */
export interface InvitationView {
  id: string;
  email: string;
  employeeId: string | null;
  employeeName: string | null;
  roleName: string | null;
  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  state: InvitationState;
}

const stateOf = (row: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): InvitationState =>
  row.acceptedAt ? "ACCEPTED" : row.revokedAt ? "REVOKED" : row.expiresAt <= now ? "EXPIRED" : "PENDING";

/**
 * Invitations, newest first (`users.view`). An invitation belongs to the employee it was issued
 * for, so it is visible exactly when that employee is inside the caller's data scope; invitations
 * not tied to an employee are visible to tenant-wide user administrators only. The scope is part of
 * the query, so paging cannot leak rows. The single-use token is never read.
 */
export async function listInvitations(
  actor: Actor,
  query: { cursor?: string; limit: number; state?: InvitationState },
): Promise<Page<InvitationView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "users.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "users.view", now);

    const where: Prisma.InvitationWhereInput[] = [{ tenantId: actor.tenantId }];
    if (!scope.tenantWide) {
      const visible = await tx.employee.findMany({
        where: withinScope(buildScopeWhere(scope, employeeScopeColumns, now), { tenantId: actor.tenantId }),
        select: { id: true },
      });
      where.push({ employeeId: { in: visible.map((employee) => employee.id) } });
    }
    switch (query.state) {
      case "PENDING":
        where.push({ acceptedAt: null, revokedAt: null, expiresAt: { gt: now } });
        break;
      case "ACCEPTED":
        where.push({ acceptedAt: { not: null } });
        break;
      case "REVOKED":
        where.push({ acceptedAt: null, revokedAt: { not: null } });
        break;
      case "EXPIRED":
        where.push({ acceptedAt: null, revokedAt: null, expiresAt: { lte: now } });
        break;
    }

    const rows = await tx.invitation.findMany({
      where: { AND: where },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, email: true, employeeId: true, roleId: true, invitedById: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);

    const employeeIds = page.data.map((row) => row.employeeId).filter((id): id is string => id !== null);
    const roleIds = page.data.map((row) => row.roleId).filter((id): id is string => id !== null);
    const inviterIds = page.data.map((row) => row.invitedById).filter((id): id is string => id !== null);
    const [employees, roles, inviters] = await Promise.all([
      tx.employee.findMany({ where: { tenantId: actor.tenantId, id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }),
      tx.role.findMany({ where: { tenantId: actor.tenantId, id: { in: roleIds } }, select: { id: true, name: true } }),
      tx.user.findMany({
        where: { tenantId: actor.tenantId, id: { in: inviterIds } },
        select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } },
      }),
    ]);
    const employeeName = new Map(employees.map((employee) => [employee.id, `${employee.firstName} ${employee.lastName}`]));
    const roleName = new Map(roles.map((role) => [role.id, role.name]));
    const inviterName = new Map(inviters.map((user) => [user.id, user.employee ? `${user.employee.firstName} ${user.employee.lastName}` : user.email]));

    return {
      data: page.data.map((row) => ({
        id: row.id,
        email: row.email,
        employeeId: row.employeeId,
        employeeName: row.employeeId ? (employeeName.get(row.employeeId) ?? null) : null,
        roleName: row.roleId ? (roleName.get(row.roleId) ?? null) : null,
        invitedByName: row.invitedById ? (inviterName.get(row.invitedById) ?? null) : null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        state: stateOf(row, now),
      })),
      page: page.page,
    };
  });
}
