import type { Prisma } from "@prisma/client";
import { buildScopeWhere, enforceInTx, projectFields, projectRows, resolveScope, withinScope } from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { ROLE_FIELD_MAP, roleSelect, toRoleView } from "./role-fields";
import type { ListRolesQuery } from "./schemas";

type Projected = Record<string, unknown>;

/**
 * One page of roles, ordered by name (`permissions.view`). Roles are tenant-level records with no
 * org placement, so ONLY a tenant-wide grant matches them: the scope fragment (`withinScope`)
 * leaves a unit-scoped holder with an empty page rather than showing company-wide role definitions.
 */
export async function listRoles(actor: Actor, query: ListRolesQuery): Promise<Page<Projected>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "permissions.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "permissions.view", now);
    const callerWhere: Prisma.RoleWhereInput = {
      tenantId: actor.tenantId,
      ...(query.active === "all" ? {} : { active: query.active === "true" }),
      ...(query.search ? { name: { contains: query.search, mode: "insensitive" } } : {}),
    };
    const rows = await tx.role.findMany({
      where: withinScope(buildScopeWhere(scope, {}, now), callerWhere),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: roleSelect,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const data = projectRows(
      page.data.map((row) => toRoleView(row, { withPermissions: false })),
      scope,
      ROLE_FIELD_MAP,
      () => ({}),
    );
    return { data, page: page.page };
  });
}

/** One role with its permissions and their qualifiers (`permissions.view`, tenant-wide). */
export async function getRole(actor: Actor, roleId: string): Promise<Projected> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "permissions.view", {});
    const role = await tx.role.findFirst({ where: { id: roleId, tenantId: actor.tenantId }, select: roleSelect });
    if (!role) throw new NotFoundError();
    return projectFields(toRoleView(role, { withPermissions: true }), decision, ROLE_FIELD_MAP);
  });
}
