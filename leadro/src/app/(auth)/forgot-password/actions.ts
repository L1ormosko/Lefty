"use server";

import { z } from "zod";
import { requestPasswordReset } from "@/server/auth";
import { messageForError } from "../../_lib/action-errors";
import type { FormState } from "../../_lib/form-state";
import { getPageContext } from "../../_lib/page-context";
import { getClientInfo } from "../../_lib/request-client";

const forgotPasswordSchema = z.object({
  tenantSlug: z.string().trim().min(1).max(100),
  email: z.string().trim().min(1).max(320),
});

/**
 * Starts a password reset. The answer is identical whether or not the account exists (§22): the
 * service returns nothing and sends the link out of band, so this screen can never be used to
 * discover accounts. Only a throttling error differs, and it does not depend on the input.
 */
export async function requestPasswordResetAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const { t } = await getPageContext();
  const parsed = forgotPasswordSchema.safeParse({
    tenantSlug: formData.get("tenantSlug"),
    email: formData.get("email"),
  });
  const fields = { tenantSlug: String(formData.get("tenantSlug") ?? ""), email: String(formData.get("email") ?? "") };
  if (!parsed.success) return { error: t("AUTH_UI.FILL_ALL_FIELDS"), fields };

  try {
    await requestPasswordReset(parsed.data, await getClientInfo());
  } catch (error) {
    return { error: messageForError(error, t), fields };
  }
  return { success: t("AUTH_UI.RESET_REQUEST_SENT") };
}
