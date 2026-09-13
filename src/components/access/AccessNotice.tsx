import Link from "next/link";
import { t } from "@/lib/labels";
import { COMMITMENT_MONTHS, TRIAL_DAYS, trialEndingSoon, type Access } from "@/lib/subscription";
import { buttonClass } from "@/components/ui";

/**
 * What the viewer's access is, said where they will notice it.
 *
 * Four states, three of which say something:
 *
 *   trial   - a countdown, and only a warning once it is nearly over. A banner
 *             on day one of seven is nagging.
 *   lapsed  - what happened, and how to fix it.
 *   none    - the pitch, because this person has never had access and the
 *             restricted map they are looking at is the argument for signing up.
 *   paid    - nothing at all. A paying customer does not need reminding.
 */
export function AccessNotice({ access, className }: { access: Access; className?: string }) {
  if (access.state === "paid") return null;

  if (access.state === "trial") {
    // Silent until the end is close enough to matter.
    if (!trialEndingSoon(access)) return null;
    return (
      <div
        className={`rounded-md border border-warn-200 bg-warn-50 px-3 py-2 text-sm text-warn-800 ${className ?? ""}`}
      >
        {t("access.trialEndingSoon", { days: `\u2068${access.trialDaysLeft ?? 0}\u2069` })}
      </div>
    );
  }

  const lapsed = access.state === "lapsed";

  return (
    <div
      className={`rounded-md border border-brand-200 bg-brand-50 p-3 text-sm ${className ?? ""}`}
    >
      <p className="font-medium text-ink-900">
        {lapsed ? t("access.lapsed") : t("access.restrictedMapNote")}
      </p>
      {lapsed ? (
        <p className="mt-1 text-ink-700">{t("access.lapsedCta")}</p>
      ) : (
        <>
          <p className="mt-1 text-ink-700">
            {t("access.trialCtaNote", { months: `\u2068${COMMITMENT_MONTHS}\u2069` })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Link href="/register" className={buttonClass("primary", "sm")}>
              {t("access.startTrial")}
            </Link>
            <Link href="/login" className="text-brand-600 hover:underline">
              {t("access.haveAccount")}
            </Link>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {t("access.trialCta", { days: `\u2068${TRIAL_DAYS}\u2069` })}
          </p>
        </>
      )}
    </div>
  );
}
