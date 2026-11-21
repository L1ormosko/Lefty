"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { login, type LoginResult } from "@/server/auth";
import { messageForError } from "../../_lib/action-errors";
import type { FormState } from "../../_lib/form-state";
import { getPageContext } from "../../_lib/page-context";
import { getClientInfo } from "../../_lib/request-client";
import { setSessionCookie } from "../../_lib/session-cookie";

const loginFormSchema = z.object({
  tenantSlug: z.string().trim().min(1).max(100),
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1000),
});

/**
 * Login step 1: company code + email + password (§22.1). Every credential problem shows the one
 * generic "incorrect" text (the auth service already throws a single generic error). On success
 * the session cookie is set and the user goes to the MFA step when a second factor is outstanding,
 * otherwise to the workspace.
 */
export async function loginAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const { t } = await getPageContext();
  const parsed = loginFormSchema.safeParse({
    tenantSlug: formData.get("tenantSlug"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  const fields = { tenantSlug: String(formData.get("tenantSlug") ?? ""), email: String(formData.get("email") ?? "") };
  if (!parsed.success) return { error: t("AUTH_UI.FILL_ALL_FIELDS"), fields };

  let result: LoginResult;
  try {
    result = await login(parsed.data, await getClientInfo());
  } catch (error) {
    return { error: messageForError(error, t, { UNAUTHENTICATED: "AUTH.LOGIN_FAILED" }), fields };
  }
  await setSessionCookie(result.token, result.expiresAt);
  // redirect() throws, so it must stay outside the try block above.
  redirect(result.mfaRequired ? "/login/mfa" : "/");
}
