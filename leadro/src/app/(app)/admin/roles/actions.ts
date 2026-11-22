"use server";

import {
  archiveRole,
  archiveRoleSchema,
  cloneRole,
  cloneRoleSchema,
  createRole,
  createRoleSchema,
  grantRoleSchema,
  grantRoleToUser,
  replacePermissionsSchema,
  saveRoleDefinition,
  revokeAssignment,
  revokeAssignmentSchema,
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
 * Saves name/description and the permission grid through ONE service transaction
 * (`saveRoleDefinition`), which also keeps the stored conditions of grants that stay ticked.
 */
export async function saveRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [ROLES_PATH, `${ROLES_PATH}/${String(formData.get("roleId") ?? "")}`],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      const update = parseWith(updateRoleSchema, { name: values.name, description: values.description ?? null });
      parseWith(replacePermissionsSchema, { permissions: ticked(data), reason: values.reason });
      await saveRoleDefinition(actor, ctx, values.roleId ?? "", { update, permissionKeys: ticked(data).map((grant) => grant.permission), reason: values.reason });
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
