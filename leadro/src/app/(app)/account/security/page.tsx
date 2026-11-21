import { StatusBadge } from "@/components/ui";
import { MfaEnrollmentPanel } from "../../../_components/MfaEnrollmentPanel";
import { mfaEnrollmentLabels } from "../../../_components/mfa-labels";
import { loadMfaEnabled } from "../../../_lib/account-queries";
import { getPageContext } from "../../../_lib/page-context";

/**
 * Two-step verification status and enrollment. There is deliberately no "turn off" button: the
 * auth module offers no disable/recovery flow yet (it would need step-up checks), and roles that
 * require MFA must not be able to drop it.
 */
export default async function SecurityPage() {
  const { actor, t } = await getPageContext();
  if (!actor) return null;
  const mfaEnabled = await loadMfaEnabled(actor);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("ACCOUNT.SECURITY_TITLE")}</h1>
        <p className="mt-1 text-sm text-ink-muted">{t("ACCOUNT.SECURITY_INTRO")}</p>
      </div>
      <section aria-labelledby="mfa-heading" className="space-y-4 rounded border border-line bg-surface p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 id="mfa-heading" className="text-lg font-semibold">
            {t("ACCOUNT.MFA_TITLE")}
          </h2>
          <StatusBadge
            tone={mfaEnabled ? "success" : "neutral"}
            label={mfaEnabled ? t("ACCOUNT.MFA_STATUS_ENABLED") : t("ACCOUNT.MFA_STATUS_DISABLED")}
          />
        </div>
        {mfaEnabled ? (
          <p className="text-sm text-ink-muted">{t("ACCOUNT.MFA_ENABLED_DESCRIPTION")}</p>
        ) : (
          <MfaEnrollmentPanel labels={mfaEnrollmentLabels(t)} />
        )}
      </section>
    </div>
  );
}
