"use server";

import { redirect } from "next/navigation";
import { completePasswordReset } from "@/server/auth";
import { ValidationError } from "@/server/core";
import { messageForError } from "../../_lib/action-errors";
import type { FormState } from "../../_lib/form-state";
import { getPageContext } from "../../_lib/page-context";
import { readNewPasswordForm } from "../../_lib/password-form";
import { getClientInfo } from "../../_lib/request-client";

/** Completes a reset: new password in, every old session out (done by the service). */
export async function resetPasswordAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const { t } = await getPageContext();
  const parsed = readNewPasswordForm(formData);
  if (!parsed.success) return { error: t("AUTH_UI.RESET_LINK_INVALID") };
  if (parsed.data.password !== parsed.data.confirmPassword) return { error: t("AUTH_UI.PASSWORDS_DO_NOT_MATCH") };

  try {
    await completePasswordReset({ token: parsed.data.token, newPassword: parsed.data.password }, await getClientInfo());
  } catch (error) {
    if (error instanceof ValidationError && error.field === "password") return { error: t("AUTH_UI.PASSWORD_POLICY") };
    return { error: messageForError(error, t, { VALIDATION_FAILED: "AUTH_UI.RESET_LINK_INVALID" }) };
  }
  redirect("/login?notice=password_reset");
}
