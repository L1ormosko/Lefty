import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { deactivateUserAccountInTx, type ClientInfo } from "@/server/auth";
import {
  buildScopeWhere,
  enforceInTx,
  enforceOnUser,
  projectFields,
  projectRows,
  resolveScope,
  withinScope,
} from "@/server/authz";
import {
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import type { ListUsersQuery, UpdateUserInput } from "./schemas";
import { flattenUser, userRowAttributes, userScopeColumns, userSelect, USER_FIELD_MAP } from "./user-fields";

/**
 * User accounts (§22). Accounts are created only by accepting an invitation (employees module),
 * so this module lists, reads, edits preferences and deactivates. A user's data scope is that of
 * their employee record (see `userScopeColumns`). Credentials never leave this module: the select
 * and the field map both exclude every secret.
 */

type Projected = Record<string, unknown>;

/** The permission target of a user: their employee, or the tenant level when they have none. */
async function resolveUserTarget(tx: TenantTx, tenantId: string, userId: string): Promise<{ employeeId: string | null }> {
  const user = await tx.user.findFirst({ where: { id: userId, tenantId }, select: { employee: { select: { id: true } } } });
  if (!user) throw new NotFoundError();
  return { employeeId: user.employee?.id ?? null };
}

/**
 * One page of users the caller may see (`users.view`), ordered by email: scope in the query,
 * fields projected per row. A user with no employee record is only visible with a tenant-wide grant.
 */
export async function listUsers(actor: Actor, query: ListUsersQuery): Promise<Page<Projected>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "users.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "users.view", now);
    const callerWhere: Prisma.UserWhereInput = {
      tenantId: actor.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: "insensitive" } },
              { employee: { firstName: { contains: query.search, mode: "insensitive" } } },
              { employee: { lastName: { contains: query.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const rows = await tx.user.findMany({
      where: withinScope(buildScopeWhere(scope, userScopeColumns, now), callerWhere),
      orderBy: [{ email: "asc" }, { id: "asc" }],
      select: userSelect(now),
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data = projectRows(page.data.map(flattenUser), scope, USER_FIELD_MAP, userRowAttributes);
    return { data, page: page.page };
  });
}

/** One user (`users.view` over them); outside the caller's scope it is a 404. */
export async function getUser(actor: Actor, userId: string): Promise<Projected> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "users.view");
    const decision = await enforceOnUser(tx, actor, "users.view", await resolveUserTarget(tx, actor.tenantId, userId));
    const row = await tx.user.findFirst({ where: { id: userId, tenantId: actor.tenantId }, select: userSelect(new Date()) });
    if (!row) throw new NotFoundError();
    return projectFields(flattenUser(row), decision, USER_FIELD_MAP);
  });
}

/** The signed-in user's own profile. Self-service: needs no permission, and exposes only their own row. */
export async function getOwnProfile(actor: Actor): Promise<Projected> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await tx.user.findFirst({ where: { id: actor.userId, tenantId: actor.tenantId }, select: userSelect(new Date()) });
    if (!row) throw new NotFoundError();
    // Own record: every mapped (non-secret) field is shown.
    return projectFields(flattenUser(row), { allowed: true, fieldSets: ["base"] }, USER_FIELD_MAP);
  });
}

/** Changes a user's locale / time zone preference. Needs `users.edit` over them; audited. */
export async function updateUser(actor: Actor, ctx: RequestContext, userId: string, input: UpdateUserInput): Promise<Projected> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "users.edit");
    const decision = await enforceOnUser(tx, actor, "users.edit", await resolveUserTarget(tx, actor.tenantId, userId));
    if (!decision.fieldSets.includes("base")) throw new ForbiddenError();

    const now = new Date();
    const row = await tx.user.findFirst({ where: { id: userId, tenantId: actor.tenantId }, select: userSelect(now) });
    if (!row) throw new NotFoundError();
    if (row.status === "DEACTIVATED") throw new InvalidStateTransitionError({ message: "A deactivated user cannot be edited." });

    const { changedKeys, previous, next } = changedFields(row, input);
    if (changedKeys.length === 0) return projectFields(flattenUser(row), decision, USER_FIELD_MAP);
    const updated = await tx.user.update({ where: { id: userId }, data: input, select: userSelect(now) });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "user.update",
      targetType: "User",
      targetId: userId,
      previousValue: previous,
      newValue: next,
    });
    return projectFields(flattenUser(updated), decision, USER_FIELD_MAP);
  });
}

/**
 * Deactivates a login and signs it out everywhere (sessions revoked, access stops immediately).
 * Needs `users.archive` over the user. Nobody deactivates themselves (they could lock the company
 * out of its last administrator); a reason is required. The record, role history and audit trail stay.
 */
export async function deactivateUser(
  actor: Actor,
  client: ClientInfo,
  userId: string,
  input: { reason: string },
): Promise<{ revokedSessions: number }> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "users.archive");
    await enforceOnUser(tx, actor, "users.archive", await resolveUserTarget(tx, actor.tenantId, userId));
    if (userId === actor.userId) throw new ForbiddenError({ message: "You cannot deactivate your own account." });
    const user = await tx.user.findFirst({ where: { id: userId, tenantId: actor.tenantId }, select: { status: true } });
    if (user?.status === "DEACTIVATED") throw new InvalidStateTransitionError({ message: "The user is already deactivated." });
    // Same transaction as the checks above. Auth owns session revocation and writes the audit event
    // (`user.deactivate`) with the reason.
    return deactivateUserAccountInTx(tx, actor.tenantId, userId, actor.userId, client, input.reason);
  });
}
