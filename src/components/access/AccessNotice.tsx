import Link from "next/link";
import { t } from "@/lib/labels";
import { COMMITMENT_MONTHS, TRIAL_DAYS, trialEndingSoon, type ViewerAccess } from "@/lib/subscription";
import { buttonClass } from "@/components/ui";

/**
 * What the viewer's access is, said where they will notice it.
 *
 * Two questions decide what this says, and for a long time it only asked one
 * of them. It knew whether the account had access; it did not know whether
 * there was an account. Both a signed-out visitor and a signed-in customer
 * with no subscription come out of `access()` as "none", so a paying-shaped
 * customer got the stranger's pitch: "open an account" over a button to
 * /register, next to "already have an account?" over a button to /login -
 * while their own name sat in the header two centimetres above.
 *
 * So the branches are:
 *
 *   paid    - nothing at all. A paying customer does not need reminding.
 *   trial   - a countdown, and only once it is nearly over. A banner on day
 *             one of seven is nagging.
 *   signed out, no access - the pitch. This person really can register, and
 *             the restricted map they are looking at is the argument for it.
 *   signed in, no access - what is missing and how to get it, pointing at
 *             /access, where there is a form that reaches a human. Never a
 *             word about registering.
 */
export function AccessNotice({ access, className }: { access: ViewerAccess; className?: string }) {
  if (access.state === "paid") return null;

  if (access.state === "trial") {
    // Silent until the end is close enough to matter.
    if (!trialEndingSoon(access)) return null;
    return (
      <div
        className={`rounded-md border border-warn-200 bg-warn-50 px-3 py-2 text-sm text-warn-800 ${className ?? ""}`}
      >
        {t("access.trialEndingSoon", { days: `⁨${access.trialDaysLeft ?? 0}⁩` })}
      </div>
    );
  }

  const lapsed = access.state === "lapsed";

  /*
   * Signed in, and out of access.
   *
   * The whole point of this branch: it never says "register" and never asks
   * whether they have an account, because the answer is sitting in their
   * session. It names what they are missing and gives them one button that
   * does something real.
   */
  if (access.signedIn) {
    return (
      <div className={`rounded-md border border-brand-200 bg-brand-50 p-3 text-sm ${className ?? ""}`}>
        <p className="font-medium text-ink-900">
          {lapsed ? t("access.lapsed") : t("access.signedInNoAccess")}
        </p>
        <p className="mt-1 text-ink-700">{t("access.signedInNote")}</p>
        <div className="mt-2">
          <Link href="/access" className={buttonClass("primary", "sm")}>
            {t("access.requestCta")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-md border border-brand-200 bg-brand-50 p-3 text-sm ${className ?? ""}`}>
      <p className="font-medium text-ink-900">{t("access.restrictedMapNote")}</p>
      <p className="mt-1 text-ink-700">
        {t("access.trialCtaNote", { months: `⁨${COMMITMENT_MONTHS}⁩` })}
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
        {t("access.trialCta", { days: `⁨${TRIAL_DAYS}⁩` })}
      </p>
    </div>
  );
}
