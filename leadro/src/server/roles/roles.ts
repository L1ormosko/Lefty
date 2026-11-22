import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import {
  assertMayDefineGrants,
  assertMayGrantToExistingHolders,
  assertNotHoldingRole,
  enforceInTx,
  projectFields,
  customRoleRequiresMfa,
  templateRequiresMfa,
} from "@/server/authz";
import {
  conflictOnUniqueViolation,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  type Actor,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { ROLE_FIELD_MAP, roleSelect, toRoleView, type RoleRow } from "./role-fields";
import type {
  ArchiveRoleInput,
  CloneRoleInput,
  CreateRoleInput,
  GrantInput,
  ReplacePermissionsInput,
  UpdateRoleInput,
} from "./schemas";

/**
 * Role administration (§4.2, §4.4, §21.3). Roles are tenant-level bundles of catalog permissions;
 * scopes belong to ASSIGNMENTS (role-assignments.ts). Every write is audited with the permission
 * delta, which is what the permission history endpoint serves.
 *
 * Two rules protect against privilege escalation and are enforced here on every write:
 *  1. Nobody can put a permission into a role (create, clone, edit) that they do not hold themselves
 *     (`assertMayDefineGrants`), including its sensitive field sets.
 *  2. Nobody can edit, re-permission or archive a role that is assigned to themselves
 *     (`assertNotHoldingRole`, separation of duties §21.3): they could otherwise rewrite their own access.
 * Role NAMES never matter for access; only the permissions in the role do.
 */

const DUPLICATE_NAME = "A role with this name already exists.";
const sameConditions = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * MFA is mandatory for roles that can change who may do what, for the always-MFA templates, and for
 * custom roles holding any sensitive permission or sensitive field set. Template-derived roles
 * (clones/edits of a shipped template) follow the template rule so e.g. a cloned Technician stays MFA-free.
 */
function mfaIsMandatory(templateKey: string | null, grants: GrantInput[]): boolean {
  const asTemplateGrants = grants.map((grant) => ({ permission: grant.permission, conditions: grant.conditions ?? undefined }));
  return templateKey === null ? customRoleRequiresMfa(asTemplateGrants) : templateRequiresMfa(templateKey, asTemplateGrants);
}

async function loadRole(tx: TenantTx, tenantId: string, roleId: string): Promise<RoleRow> {
  const role = await tx.role.findFirst({ where: { id: roleId, tenantId }, select: roleSelect });
  if (!role) throw new NotFoundError();
  return role;
}

const grantsOf = (role: RoleRow): GrantInput[] =>
  role.permissions.map((entry) => ({
    permission: entry.permission.key,
    conditions: (entry.conditions ?? undefined) as Record<string, unknown> | undefined,
  }));

/** Writes the role's permission rows. Unknown keys are rejected before this (assertMayDefineGrants). */
async function storeGrants(tx: TenantTx, tenantId: string, roleId: string, grants: GrantInput[]): Promise<void> {
  const known = await tx.permission.findMany({ where: { key: { in: grants.map((grant) => grant.permission) } }, select: { id: true, key: true } });
  const idByKey = new Map(known.map((permission) => [permission.key, permission.id]));
  await tx.rolePermission.createMany({
    data: grants.map((grant) => {
      const permissionId = idByKey.get(grant.permission);
      if (!permissionId) throw new ValidationError({ message: `Unknown permission "${grant.permission}".`, field: "permissions" });
      return {
        tenantId,
        roleId,
        permissionId,
        conditions: grant.conditions === undefined ? undefined : (grant.conditions as Prisma.InputJsonValue),
      };
    }),
  });
}

/** Creates a custom role. Needs a tenant-wide `permissions.create` and every permission in it. */
export async function createRole(actor: Actor, ctx: RequestContext, input: CreateRoleInput) {
  return conflictOnUniqueViolation(DUPLICATE_NAME, () =>
    withTenant(actor.tenantId, async (tx) => {
      const decision = await enforceInTx(tx, actor, "permissions.create", {});
      await assertMayDefineGrants(tx, actor, input.permissions);

      const role = await tx.role.create({
        data: {
          tenantId: actor.tenantId,
          name: input.name,
          description: input.description,
          requiresMfa: (input.requiresMfa ?? false) || mfaIsMandatory(null, input.permissions),
        },
        select: { id: true },
      });
      await storeGrants(tx, actor.tenantId, role.id, input.permissions);
      const created = await loadRole(tx, actor.tenantId, role.id);
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "role.create",
        targetType: "Role",
        targetId: role.id,
        newValue: { name: created.name, requiresMfa: created.requiresMfa, permissions: input.permissions },
      });
      return projectFields(toRoleView(created, { withPermissions: true }), decision, ROLE_FIELD_MAP);
    }),
  );
}

/**
 * Copies a role (including its qualifiers) under a new name: the way to customise a template without
 * touching it. The copy is an ordinary custom role (no template key, not a system template), so
 * re-provisioning templates never mistakes it for the original. Same holding rule as `createRole`.
 */
export async function cloneRole(actor: Actor, ctx: RequestContext, sourceRoleId: string, input: CloneRoleInput) {
  return conflictOnUniqueViolation(DUPLICATE_NAME, () =>
    withTenant(actor.tenantId, async (tx) => {
      const decision = await enforceInTx(tx, actor, "permissions.create", {});
      const source = await loadRole(tx, actor.tenantId, sourceRoleId);
      const grants = grantsOf(source);
      await assertMayDefineGrants(tx, actor, grants);

      const role = await tx.role.create({
        data: {
          tenantId: actor.tenantId,
          name: input.name,
          description: input.description ?? source.description,
          requiresMfa: source.requiresMfa || mfaIsMandatory(source.templateKey, grants),
        },
        select: { id: true },
      });
      await storeGrants(tx, actor.tenantId, role.id, grants);
      const created = await loadRole(tx, actor.tenantId, role.id);
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "role.clone",
        targetType: "Role",
        targetId: role.id,
        newValue: { name: created.name, clonedFromRoleId: source.id, permissions: grants },
      });
      return projectFields(toRoleView(created, { withPermissions: true }), decision, ROLE_FIELD_MAP);
    }),
  );
}

/**
 * Renames a role or edits its description / MFA flag. Needs a tenant-wide `permissions.edit` and
 * the role must not be assigned to the caller. MFA can be switched ON freely but not OFF while the
 * role's permissions (or its template) make it mandatory.
 */
export async function updateRole(actor: Actor, ctx: RequestContext, roleId: string, input: UpdateRoleInput) {
  return conflictOnUniqueViolation(DUPLICATE_NAME, () => withTenant(actor.tenantId, (tx) => updateRoleInTx(tx, actor, ctx, roleId, input)));
}

async function updateRoleInTx(tx: TenantTx, actor: Actor, ctx: RequestContext, roleId: string, input: UpdateRoleInput) {
  const decision = await enforceInTx(tx, actor, "permissions.edit", {});
  await assertNotHoldingRole(tx, actor, roleId);
  const role = await loadRole(tx, actor.tenantId, roleId);
  if (!role.active) throw new InvalidStateTransitionError({ message: "An archived role cannot be edited." });
  if (input.requiresMfa === false && mfaIsMandatory(role.templateKey, grantsOf(role))) {
    throw new ValidationError({ message: "MFA is mandatory for this role's permissions.", field: "requiresMfa" });
  }

  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const key of ["name", "description", "requiresMfa"] as const) {
    if (input[key] !== undefined && input[key] !== role[key]) {
      previous[key] = role[key];
      next[key] = input[key];
    }
  }
  if (Object.keys(next).length === 0) return projectFields(toRoleView(role, { withPermissions: true }), decision, ROLE_FIELD_MAP);

  await tx.role.update({ where: { id: roleId }, data: input });
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action: "role.update",
    targetType: "Role",
    targetId: roleId,
    previousValue: previous,
    newValue: next,
  });
  return projectFields(toRoleView(await loadRole(tx, actor.tenantId, roleId), { withPermissions: true }), decision, ROLE_FIELD_MAP);
}

/**
 * Replaces the whole permission set of a role. Needs a tenant-wide `permissions.edit`, the role must
 * not be assigned to the caller, and the caller must hold every ADDED or CHANGED grant (removing
 * something never escalates anyone). The audit event records exactly what was added, removed and
 * changed: it is the role's permission history. The MFA flag is raised when new permissions demand it.
 */
export async function replaceRolePermissions(actor: Actor, ctx: RequestContext, roleId: string, input: ReplacePermissionsInput) {
  return withTenant(actor.tenantId, (tx) => replacePermissionsInTx(tx, actor, ctx, roleId, input));
}

async function replacePermissionsInTx(tx: TenantTx, actor: Actor, ctx: RequestContext, roleId: string, input: ReplacePermissionsInput) {
  const decision = await enforceInTx(tx, actor, "permissions.edit", {});
  await assertNotHoldingRole(tx, actor, roleId);
  const role = await loadRole(tx, actor.tenantId, roleId);
  if (!role.active) throw new InvalidStateTransitionError({ message: "An archived role cannot be edited." });

  const before = new Map(grantsOf(role).map((grant) => [grant.permission, grant.conditions ?? null]));
  const after = new Map(input.permissions.map((grant) => [grant.permission, grant.conditions ?? null]));
  const added = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  const changed = [...after.keys()].filter((key) => before.has(key) && !sameConditions(before.get(key), after.get(key)));
  if (added.length + removed.length + changed.length === 0) {
    return projectFields(toRoleView(role, { withPermissions: true }), decision, ROLE_FIELD_MAP);
  }

  const toAdd = input.permissions.filter((grant) => added.includes(grant.permission) || changed.includes(grant.permission));
  await assertMayDefineGrants(tx, actor, toAdd);
  // The role may already be assigned: every live holder's scope must be one the editor could grant it in.
  await assertMayGrantToExistingHolders(tx, actor, roleId, toAdd);
  await tx.rolePermission.deleteMany({ where: { tenantId: actor.tenantId, roleId } });
  await storeGrants(tx, actor.tenantId, roleId, input.permissions);
  if (!role.requiresMfa && mfaIsMandatory(role.templateKey, input.permissions)) {
    await tx.role.update({ where: { id: roleId }, data: { requiresMfa: true } });
  }
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action: "role.permissions_change",
    targetType: "Role",
    targetId: roleId,
    previousValue: { removed, changed: changed.map((key) => ({ permission: key, conditions: before.get(key) })) },
    newValue: { added: added.map((key) => ({ permission: key, conditions: after.get(key) })), changed: changed.map((key) => ({ permission: key, conditions: after.get(key) })) },
    reason: input.reason,
  });
  return projectFields(toRoleView(await loadRole(tx, actor.tenantId, roleId), { withPermissions: true }), decision, ROLE_FIELD_MAP);
}

/**
 * Saves a role definition from an editor that only toggles permissions: name/description/MFA and the
 * set of permission KEYS, in ONE transaction (a failing permission change leaves the name untouched
 * and no audit event behind). Grants that stay selected keep their stored conditions (record sets,
 * field sets), read inside the same transaction, so concurrent edits cannot be lost and the
 * editor can never silently widen or drop a restriction. Every rule of `updateRole` and
 * `replaceRolePermissions` applies unchanged.
 */
export async function saveRoleDefinition(
  actor: Actor,
  ctx: RequestContext,
  roleId: string,
  input: { update: UpdateRoleInput; permissionKeys: string[]; reason?: string },
) {
  return conflictOnUniqueViolation(DUPLICATE_NAME, () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "permissions.edit", {}); // before any lookup: no 404-vs-403 oracle
      const current = await loadRole(tx, actor.tenantId, roleId);
      const keep = new Map(grantsOf(current).map((grant) => [grant.permission, grant.conditions]));
      const permissions = [...new Set(input.permissionKeys)].map((permission) => {
        const conditions = keep.get(permission);
        return conditions ? { permission, conditions } : { permission };
      });
      await updateRoleInTx(tx, actor, ctx, roleId, input.update);
      return replacePermissionsInTx(tx, actor, ctx, roleId, { permissions, reason: input.reason });
    }),
  );
}

/**
 * Archives a role (soft): it stops granting anything immediately, because authz ignores inactive
 * roles, while its assignments and history stay. Needs a tenant-wide `permissions.archive`, a reason,
 * and the role must not be assigned to the caller.
 */
export async function archiveRole(actor: Actor, ctx: RequestContext, roleId: string, input: ArchiveRoleInput) {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "permissions.archive", {});
    await assertNotHoldingRole(tx, actor, roleId);
    const role = await loadRole(tx, actor.tenantId, roleId);
    if (!role.active) throw new InvalidStateTransitionError({ message: "The role is already archived." });

    await tx.role.update({ where: { id: roleId }, data: { active: false } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "role.archive",
      targetType: "Role",
      targetId: roleId,
      previousValue: { active: true },
      newValue: { active: false },
      reason: input.reason,
    });
    return projectFields(toRoleView(await loadRole(tx, actor.tenantId, roleId), { withPermissions: false }), decision, ROLE_FIELD_MAP);
  });
}
