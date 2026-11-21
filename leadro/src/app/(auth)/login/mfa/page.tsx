import { redirect } from "next/navigation";
import { verifyMfaAction } from "../../../_actions/mfa";
import { logoutAction } from "../../../_actions/session";
import { MfaCodeForm } from "../../../_components/MfaCodeForm";
import { MfaEnrollmentPanel } from "../../../_components/MfaEnrollmentPanel";
import { mfaEnrollmentLabels } from "../../../_components/mfa-labels";
import { loadMfaEnabled } from "../../../_lib/account-queries";
import { getPageContext } from "../../../_lib/page-context";

/**
 * Login step 2. Only reachable with a password-verified session that still owes MFA: no session
 * goes back to login, a complete one goes on to the workspace. Users who have not enrolled yet
 * (a role newly requires MFA) set up their authenticator here instead of being locked out.
 */
export default async function MfaStepPage() {
  const { actor, mfaPending, t } = await getPageContext();
  if (!actor) redirect("/login");
  if (!mfaPending) redirect("/");

  const mfaEnabled = await loadMfaEnabled(actor);

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">
        {mfaEnabled ? t("AUTH_UI.MFA_TITLE") : t("AUTH_UI.MFA_ENROLL_TITLE")}
      </h1>
      <p className="mb-5 text-sm text-ink-muted">
        {mfaEnabled ? t("AUTH.MFA_REQUIRED") : t("AUTH_UI.MFA_ENROLL_INTRO")}
      </p>
      {mfaEnabled ? (
        <MfaCodeForm
          action={verifyMfaAction}
          codeLabel={t("AUTH_UI.MFA_CODE_LABEL")}
          codeHint={t("AUTH_UI.MFA_CODE_HINT")}
          submitLabel={t("AUTH_UI.MFA_VERIFY")}
        />
      ) : (
        <MfaEnrollmentPanel labels={mfaEnrollmentLabels(t)} />
      )}
      <form action={logoutAction} className="mt-6 text-center text-sm">
        <button type="submit" className="text-brand-700 underline">
          {t("AUTH_UI.MFA_CANCEL")}
        </button>
      </form>
    </>
  );
}
