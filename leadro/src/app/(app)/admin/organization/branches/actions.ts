"use server";

import { createOrgUnit, createOrgUnitSchema, updateOrgUnit, updateOrgUnitSchema } from "@/server/organization";
import type { FormState } from "../../../../_lib/form-state";
import { formValues, parseWith, runAdminAction } from "../../_lib/admin-action";
import { branchAttributesForCreate, branchAttributesForUpdate } from "../../_lib/branch-form";

const REVALIDATE = ["/admin/organization/branches", "/admin/organization"];

/** Adds a BRANCH under a city or region. */
export async function createBranchAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: REVALIDATE,
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      const input = parseWith(createOrgUnitSchema, {
        type: "BRANCH",
        name: values.name,
        code: values.code,
        parentId: values.parentId,
        legalEntityId: values.legalEntityId,
        ...branchAttributesForCreate(values),
      });
      await createOrgUnit(actor, ctx, input);
      return t("ADMIN.BRANCH_ADDED");
    },
  });
}

/** Edits a branch's name, code, address, time zone, language and opening hours. */
export async function updateBranchAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: REVALIDATE,
    run: async ({ actor, ctx, t }, data) => {
      const values = formValues(data);
      const input = parseWith(updateOrgUnitSchema, {
        name: values.name,
        code: values.code ?? null,
        ...branchAttributesForUpdate(values),
      });
      await updateOrgUnit(actor, ctx, values.unitId ?? "", input);
      return t("ADMIN.SAVED");
    },
  });
}
