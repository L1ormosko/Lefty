"use server";

import {
  createEmployee,
  createEmployeeSchema,
  endAssignmentSchema,
  endEmployeeAssignment,
  inviteEmployee,
  inviteEmployeeSchema,
  terminateEmployee,
  terminateEmployeeSchema,
  updateEmployee,
  updateEmployeeSchema,
} from "@/server/employees";
import type { FormState } from "../../../_lib/form-state";
import { formValues, parseWith, runAdminAction, withConflictField } from "../_lib/admin-action";
import { inviteInputFromForm } from "../_lib/invite-form";

const EMPLOYEES_PATH = "/admin/employees";
const requiredId = (value: string | undefined): string => value ?? "";

/** Adds an employee record (and their first placement when a unit is chosen). */
export async function createEmployeeAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [EMPLOYEES_PATH, "/admin/organization"],
    run: async ({ actor, ctx, t }, data) => {
      await withConflictField("employeeNumber", () => createEmployee(actor, ctx, parseWith(createEmployeeSchema, formValues(data))));
      return t("ADMIN.EMPLOYEE_ADDED");
    },
  });
}

/**
 * Edits an employee. The profile form is pre-filled, so a blank optional field means "clear it":
 * those become explicit nulls (the schema's way to remove a value).
 */
export async function updateEmployeeAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [EMPLOYEES_PATH],
    run: async ({ actor, ctx, t }, data) => {
      const { employeeId, ...values } = formValues(data);
      const input = parseWith(updateEmployeeSchema, {
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email ?? null,
        phone: values.phone ?? null,
        jobTitle: values.jobTitle ?? null,
        employeeNumber: values.employeeNumber ?? null,
        legalEntityId: values.legalEntityId ?? null,
        hireDate: values.hireDate ?? null,
        status: values.status,
      });
      await withConflictField("employeeNumber", () => updateEmployee(actor, ctx, requiredId(employeeId), input));
      return t("ADMIN.SAVED");
    },
  });
}

/** Ends employment: soft, with a date and reason; closes placements and deactivates the login. */
export async function terminateEmployeeAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [EMPLOYEES_PATH, "/admin/users", "/admin/organization"],
    run: async ({ actor, ctx, t }, data) => {
      const { employeeId, ...values } = formValues(data);
      await terminateEmployee(actor, ctx, requiredId(employeeId), parseWith(terminateEmployeeSchema, values));
      return t("ADMIN.EMPLOYEE_TERMINATED");
    },
  });
}

/** Ends an extra (secondary / temporary) placement early. */
export async function endAssignmentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [EMPLOYEES_PATH, "/admin/organization"],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      const input = parseWith(endAssignmentSchema, { reason: values.reason });
      await endEmployeeAssignment(actor, ctx, requiredId(values.employeeId), requiredId(values.assignmentId), input);
      return t("ADMIN.EMPLOYEE_ASSIGNMENT_ENDED");
    },
  });
}

/**
 * Invites an employee to create a login. The service checks `users.create` over the employee and,
 * with a role, the anti-escalation rules. The invitation token goes to the notifier, never here.
 */
export async function inviteEmployeeAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [EMPLOYEES_PATH, "/admin/users"],
    run: async ({ actor, client, t }, data) => {
      const values = formValues(data);
      const input = parseWith(inviteEmployeeSchema, inviteInputFromForm(values));
      await inviteEmployee(actor, requiredId(values.employeeId), input, client);
      return t("ADMIN.INVITE_SENT");
    },
  });
}
