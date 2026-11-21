"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  EncryptionKeyError,
  confirmMfaEnrollment,
  startMfaEnrollment,
  verifyMfaChallenge,
  type PromotedSession,
} from "@/server/auth";
import { messageForError } from "../_lib/action-errors";
import type { FormState } from "../_lib/form-state";
import { getPageContext } from "../_lib/page-context";
import { getClientInfo } from "../_lib/request-client";
import { setSessionCookie } from "../_lib/session-cookie";

/** State of the enrollment panel: the seed is only ever shown from this state, never stored. */
export interface EnrollmentStartState extends FormState {
  /** Base32 seed for manual entry. */
  secret?: string;
  /** `otpauth://` URI (contains the seed). */
  otpauthUri?: string;
}

/*
 * MFA actions serve two places: the login challenge (session still `mfaPending`) and the account
 * security page (fully signed in). `getPageContext` accepts both session kinds, so one set of
 * actions covers them; the auth service itself decides what each session may do.
 */

/** Hands the rotated token (the pre-MFA one stops working) to the browser. */
async function adoptPromotedSession(promoted: PromotedSession | null): Promise<void> {
  if (promoted) await setSessionCookie(promoted.token, promoted.expiresAt);
}

function codeFrom(formData: FormData): string {
  return String(formData.get("code") ?? "").replace(/\s+/g, "");
}

/** Login step 2: checks the authenticator code, then continues to the workspace. */
export async function verifyMfaAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const { actor, t } = await getPageContext();
  if (!actor) redirect("/login");
  const code = codeFrom(formData);
  if (!code) return { error: t("AUTH_UI.MFA_CODE_INVALID") };
  try {
    await adoptPromotedSession(await verifyMfaChallenge(actor, code, await getClientInfo()));
  } catch (error) {
    return {
      error: messageForError(error, t, {
        VALIDATION_FAILED: "AUTH_UI.MFA_CODE_INVALID",
        INVALID_STATE_TRANSITION: "AUTH_UI.MFA_NOT_SET_UP",
      }),
    };
  }
  redirect("/");
}

/** Creates a new authenticator seed and returns it for display (manual key + otpauth URI). */
export async function startMfaEnrollmentAction(): Promise<EnrollmentStartState> {
  const { actor, t } = await getPageContext();
  if (!actor) redirect("/login");
  try {
    const enrollment = await startMfaEnrollment(actor, await getClientInfo());
    return { secret: enrollment.secret, otpauthUri: enrollment.otpauthUri };
  } catch (error) {
    // No encryption key configured: say so plainly instead of a generic failure.
    if (error instanceof EncryptionKeyError) return { error: t("AUTH_UI.MFA_UNAVAILABLE") };
    return { error: messageForError(error, t, { CONFLICT: "AUTH_UI.MFA_ALREADY_ENABLED" }) };
  }
}

/**
 * Finishes enrollment with the first code. During login the session is promoted and the user
 * continues to the workspace; from the account page the page refreshes to show "enabled".
 */
export async function confirmMfaEnrollmentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const { actor, mfaPending, t } = await getPageContext();
  if (!actor) redirect("/login");
  const code = codeFrom(formData);
  if (!code) return { error: t("AUTH_UI.MFA_CODE_INVALID") };
  try {
    await adoptPromotedSession(await confirmMfaEnrollment(actor, code, await getClientInfo()));
  } catch (error) {
    return {
      error: messageForError(error, t, {
        VALIDATION_FAILED: "AUTH_UI.MFA_CODE_INVALID",
        INVALID_STATE_TRANSITION: "AUTH_UI.MFA_NOT_SET_UP",
        CONFLICT: "AUTH_UI.MFA_ALREADY_ENABLED",
      }),
    };
  }
  if (mfaPending) redirect("/");
  revalidatePath("/account/security");
  return { success: t("ACCOUNT.MFA_ENABLED_NOTICE") };
}
