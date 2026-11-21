"use server";

import { assignEmployeeSchema, assignEmployeeToUnit } from "@/server/employees";
import {
  archiveOrgUnit,
  archiveSchema,
  assignManagerSchema,
  assignUnitManager,
  createOrgUnit,
  createOrgUnitSchema,
  moveOrgUnit,
  moveOrgUnitSchema,
  unassignUnitManager,
  updateOrgUnit,
  updateOrgUnitSchema,
} from "@/server/organization";
import type { FormState } from "../../../_lib/form-state";
import { formValues, parseWith, runAdminAction } from "../_lib/admin-action";
import { endOfDayInstant } from "../_lib/dates";

const ORGANIZATION_PATH = "/admin/organization";
const REVALIDATE = [ORGANIZATION_PATH, `${ORGANIZATION_PATH}/branches`, `${ORGANIZATION_PATH}/history`];
const requiredId = (value: string | undefined): string => value ?? "";

/** Adds a unit under a parent (or at the top). The service checks `organization.create` over the parent. */
export async function createUnitAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: REVALIDATE,
    run: async ({ actor, ctx, t }, data) => {
      await createOrgUnit(actor, ctx, parseWith(createOrgUnitSchema, formValues(data)));
      return t("ADMIN.ORG_UNIT_ADDED");
    },
  });
}

/** Renames a unit and/or edits its code. */
export async function updateUnitAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: REVALIDATE,
    run: async ({ actor, ctx, t }, data) => {
      const { unitId, ...changes } = formValues(data);
      await updateOrgUnit(actor, ctx, requiredId(unitId), parseWith(updateOrgUnitSchema, changes));
      return t("ADMIN.SAVED");
    },
  });
}

/** Re-parents a unit. Cycle / type / archived-parent violations come back as a translated error. */
export async function moveUnitAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: REVALIDATE,
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      // An empty choice means "top level"; the schema wants an explicit null for that.
      const input = parseWith(moveOrgUnitSchema, { newParentId: values.newParentId ?? null, reason: values.reason });
      await moveOrgUnit(actor, ctx, requiredId(values.unitId), input);
      return t("ADMIN.ORG_UNIT_MOVED");
    },
  });
}

/** Archives a unit (soft). Refused while it has active children or people. */
export async function archiveUnitAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: REVALIDATE,
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      await archiveOrgUnit(actor, ctx, requiredId(values.unitId), parseWith(archiveSchema, { reason: values.reason }));
      return t("ADMIN.ORG_UNIT_ARCHIVED");
    },
  });
}

/** Makes an employee a manager of a unit. */
export async function assignManagerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: REVALIDATE,
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      const input = parseWith(assignManagerSchema, { employeeId: values.employeeId, isPrimary: values.isPrimary === "on" });
      await assignUnitManager(actor, ctx, requiredId(values.unitId), input);
      return t("ADMIN.ORG_MANAGER_ASSIGNED");
    },
  });
}

/** Ends a manager assignment (kept as history). */
export async function unassignManagerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: REVALIDATE,
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      await unassignUnitManager(actor, ctx, requiredId(values.unitId), requiredId(values.managerId));
      return t("ADMIN.ORG_MANAGER_ENDED");
    },
  });
}

/** Places an employee in this unit (transfer for PRIMARY, extra placement for SECONDARY / TEMPORARY). */
export async function assignEmployeeAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [...REVALIDATE, "/admin/employees"],
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      const input = parseWith(assignEmployeeSchema, {
        orgUnitId: values.orgUnitId,
        kind: values.kind ?? "PRIMARY",
        effectiveTo: endOfDayInstant(values.effectiveTo),
        reason: values.reason,
      });
      await assignEmployeeToUnit(actor, ctx, requiredId(values.employeeId), input);
      return t("ADMIN.ORG_EMPLOYEE_ASSIGNED");
    },
  });
}
