"use server";

import { deactivateUser, deactivateUserSchema } from "@/server/users";
import type { FormState } from "../../../_lib/form-state";
import { formValues, parseWith, runAdminAction } from "../_lib/admin-action";

/**
 * Deactivates a login and signs it out everywhere. Needs `users.archive` over the user; nobody can
 * deactivate themselves (the service refuses). Inviting lives with the employee actions
 * (`inviteEmployeeAction`), because an invitation is issued for an employee record.
 */
export async function deactivateUserAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: ["/admin/users", "/admin/employees"],
    run: async ({ actor, client, t }, data) => {
      const values = formValues(data);
      await deactivateUser(actor, client, values.userId ?? "", parseWith(deactivateUserSchema, { reason: values.reason }));
      return t("ADMIN.USERS_DEACTIVATED");
    },
  });
}
