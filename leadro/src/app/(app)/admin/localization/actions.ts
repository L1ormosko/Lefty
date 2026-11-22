"use server";

import { deleteOverrideAsActor, reviewOverrideAsActor, saveOverrideAsActor, toAppError, TranslationOverrideError } from "@/server/i18n";
import type { FormState } from "../../../_lib/form-state";
import { runAdminAction } from "../_lib/admin-action";

const PATH = "/admin/localization";
const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/** Wraps the module's own error type, which services outside `*AsActor` may still throw. */
async function mapped<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw error instanceof TranslationOverrideError ? toAppError(error) : error;
  }
}

/** Creates or edits an override. It lands UNREVIEWED and is not served until a reviewer approves it. */
export async function saveOverrideAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [PATH],
    run: async ({ actor, ctx, t }, data) => {
      // The value is NOT trimmed or blanked: whitespace and placeholders are part of the text.
      await mapped(() => saveOverrideAsActor(actor, ctx, { locale: text(data, "locale"), key: text(data, "key").trim(), value: text(data, "value") }));
      return t("ADMIN.LOCALIZATION_SAVED");
    },
  });
}

/** Approves exactly the text the reviewer saw (`reviewedValue`); a concurrent edit becomes a conflict. */
export async function reviewOverrideAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [PATH],
    run: async ({ actor, ctx, t }, data) => {
      await mapped(() => reviewOverrideAsActor(actor, ctx, { locale: text(data, "locale"), key: text(data, "key"), reviewedValue: text(data, "reviewedValue") }));
      return t("ADMIN.LOCALIZATION_REVIEWED");
    },
  });
}

/** Removes an override so the built-in text is used again. */
export async function deleteOverrideAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAdminAction(formData, {
    revalidate: [PATH],
    run: async ({ actor, ctx, t }, data) => {
      await mapped(() => deleteOverrideAsActor(actor, ctx, { locale: text(data, "locale"), key: text(data, "key") }));
      return t("ADMIN.LOCALIZATION_DELETED");
    },
  });
}
