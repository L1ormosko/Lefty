"use server";

import { redirect } from "next/navigation";
import { acceptInvitation } from "@/server/auth";
import { ValidationError } from "@/server/core";
import { messageForError } from "../../_lib/action-errors";
import type { FormState } from "../../_lib/form-state";
import { getPageContext } from "../../_lib/page-context";
import { readNewPasswordForm } from "../../_lib/password-form";
import { getClientInfo } from "../../_lib/request-client";

/**
 * Sets the password for an invited account and activates it; the user then signs in normally (the
 * service creates no session). Unknown/expired/used links all produce the same text.
 */
export async function acceptInvitationAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const { t } = await getPageContext();
  const parsed = readNewPasswordForm(formData);
  if (!parsed.success) return { error: t("AUTH_UI.INVITATION_INVALID") };
  if (parsed.data.password !== parsed.data.confirmPassword) return { error: t("AUTH_UI.PASSWORDS_DO_NOT_MATCH") };

  try {
    await acceptInvitation({ token: parsed.data.token, password: parsed.data.password }, await getClientInfo());
  } catch (error) {
    // The password policy is the only validation problem the user can fix; everything else about
    // the token is deliberately one generic message.
    if (error instanceof ValidationError && error.field === "password") return { error: t("AUTH_UI.PASSWORD_POLICY") };
    return { error: messageForError(error, t, { VALIDATION_FAILED: "AUTH_UI.INVITATION_INVALID", CONFLICT: "AUTH_UI.INVITATION_INVALID" }) };
  }
  redirect("/login?notice=invitation_accepted");
}
