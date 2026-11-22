"use server";

import { createLegalEntity, createLegalEntitySchema, updateTenantProfile, updateTenantProfileSchema } from "@/server/organization";
import type { FormState } from "../../../_lib/form-state";
import { formValues, parseWith, runAdminAction } from "../_lib/admin-action";

const COMPANY_PATH = "/admin/company";

/** Edits the company name and/or the company defaults (language, time zone). Needs `company_settings.edit`. */
export async function updateCompanyProfileAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [COMPANY_PATH],
    run: async ({ actor, ctx, t }, data) => {
      await updateTenantProfile(actor, ctx, parseWith(updateTenantProfileSchema, formValues(data)));
      return t("ADMIN.SAVED");
    },
  });
}

/** Adds a legal entity (an employing company). Needs a tenant-wide `organization.create`. */
export async function createLegalEntityAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [COMPANY_PATH],
    run: async ({ actor, ctx, t }, data) => {
      await createLegalEntity(actor, ctx, parseWith(createLegalEntitySchema, formValues(data)));
      return t("ADMIN.COMPANY_LEGAL_ENTITY_ADDED");
    },
  });
}
