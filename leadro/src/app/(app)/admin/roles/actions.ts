"use server";

import {
  archiveRole,
  archiveRoleSchema,
  cloneRole,
  cloneRoleSchema,
  createRole,
  createRoleSchema,
  getRole,
  grantRoleSchema,
  grantRoleToUser,
  replacePermissionsSchema,
  replaceRolePermissions,
  revokeAssignment,
  revokeAssignmentSchema,
  updateRole,
  updateRoleSchema,
} from "@/server/roles";
import type { FormState } from "../../../_lib/form-state";
import { formValues, parseWith, runAdminAction } from "../_lib/admin-action";
import { endOfDayInstant } from "../_lib/dates";
import { scopeFromForm } from "../_lib/invite-form";

const ROLES_PATH = "/admin/roles";

/** Permission keys ticked in the grid (`permission` checkboxes), as plain grants. */
const ticked = (formData: FormData) => formData.getAll("permission").filter((v): v is string => typeof v === "string").map((permission) => ({ permission }));

/** Creates a custom role from the ticked permissions. The service forbids granting what you do not hold. */
export async function createRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [ROLES_PATH],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      await createRole(actor, ctx, parseWith(createRoleSchema, { name: values.name, description: values.description, permissions: ticked(data) }));
      return t("ADMIN.ROLES_CREATED");
    },
  });
}

/** Copies a role (permissions included) under a new name. */
export async function cloneRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [ROLES_PATH],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      await cloneRole(actor, ctx, values.roleId ?? "", parseWith(cloneRoleSchema, { name: values.name, description: values.description }));
      return t("ADMIN.ROLES_CLONED");
    },
  });
}

/**
 * Saves name/description and the permission grid. Grants that stay ticked keep their stored
 * conditions (record sets, field sets): the grid only toggles permissions, it must never silently
 * widen or drop a restriction.
 */
export async function saveRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [ROLES_PATH, `${ROLES_PATH}/${String(formData.get("roleId") ?? "")}`],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      const roleId = values.roleId ?? "";
      const current = (await getRole(actor, roleId)) as { permissions?: Array<{ permission: string; conditions: unknown }> };
      const keep = new Map((current.permissions ?? []).map((grant) => [grant.permission, grant.conditions]));
      const permissions = ticked(data).map(({ permission }) => {
        const conditions = keep.get(permission);
        return conditions ? { permission, conditions } : { permission };
      });
      await updateRole(actor, ctx, roleId, parseWith(updateRoleSchema, { name: values.name, description: values.description ?? null }));
      await replaceRolePermissions(actor, ctx, roleId, parseWith(replacePermissionsSchema, { permissions, reason: values.reason }));
      return t("ADMIN.SAVED");
    },
  });
}

export async function archiveRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [ROLES_PATH],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      await archiveRole(actor, ctx, values.roleId ?? "", parseWith(archiveRoleSchema, { reason: values.reason }));
      return t("ADMIN.ROLES_ARCHIVED");
    },
  });
}

/** Grants a role to a user with an explicit scope and optional expiry. Anti-escalation is the service's. */
export async function grantRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [ROLES_PATH, `${ROLES_PATH}/${String(formData.get("roleId") ?? "")}`],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      const scope = scopeFromForm(values);
      const input = parseWith(grantRoleSchema, {
        userId: values.userId,
        roleId: values.roleId,
        scopes: scope ? [scope] : [],
        effectiveTo: endOfDayInstant(values.effectiveTo),
        reason: values.reason,
      });
      await grantRoleToUser(actor, ctx, input);
      return t("ADMIN.ROLES_GRANTED");
    },
  });
}

export async function revokeAssignmentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [ROLES_PATH, `${ROLES_PATH}/${String(formData.get("roleId") ?? "")}`],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      await revokeAssignment(actor, ctx, values.assignmentId ?? "", parseWith(revokeAssignmentSchema, { reason: values.reason }));
      return t("ADMIN.ROLES_REVOKED");
    },
  });
}
