import type { TranslateFn } from "@/lib/i18n";
import type { MfaEnrollmentLabels } from "./MfaEnrollmentPanel";

/** Translated texts for the enrollment panel, shared by the login MFA step and the security page. */
export function mfaEnrollmentLabels(t: TranslateFn): MfaEnrollmentLabels {
  return {
    start: t("ACCOUNT.MFA_START_SETUP"),
    instructions: t("ACCOUNT.MFA_SETUP_INSTRUCTIONS"),
    manualKeyLabel: t("ACCOUNT.MFA_MANUAL_KEY"),
    uriLabel: t("ACCOUNT.MFA_OTPAUTH_URI"),
    uriHelp: t("ACCOUNT.MFA_URI_HELP"),
    codeLabel: t("AUTH_UI.MFA_CODE_LABEL"),
    codeHint: t("AUTH_UI.MFA_CODE_HINT"),
    confirm: t("ACCOUNT.MFA_CONFIRM_SETUP"),
  };
}
