import { UserProfileCard, buttonClasses, focusRing } from "@/components/ui";
import type { TranslateFn } from "@/lib/i18n";
import { logoutAction } from "../../_actions/session";
import type { OwnAccountSummary } from "@/server/users";

/**
 * Account menu: who you are, your sessions, security settings, sign out. A native `<details>`
 * keeps it keyboard accessible (Enter/Space on the summary) without any client script.
 */
export function UserMenu({ identity, t }: { identity: OwnAccountSummary; t: TranslateFn }) {
  const linkClasses = `block rounded px-3 py-2 text-sm text-start hover:bg-neutral-soft ${focusRing}`;
  return (
    <details className="relative">
      <summary
        className={`flex cursor-pointer list-none items-center gap-2 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm ${focusRing}`}
      >
        <span className="max-w-40 truncate">{identity.displayName}</span>
        <span className="sr-only">{t("SHELL.USER_MENU")}</span>
      </summary>
      <div className="absolute end-0 z-20 mt-2 w-72 space-y-2 rounded border border-line bg-surface p-2 shadow-overlay">
        <UserProfileCard name={identity.displayName} email={identity.email} subtitle={identity.tenantName} />
        <nav aria-label={t("SHELL.USER_MENU")}>
          <a href="/account/sessions" className={linkClasses}>
            {t("ACCOUNT.SESSIONS_TITLE")}
          </a>
          <a href="/account/security" className={linkClasses}>
            {t("ACCOUNT.SECURITY_TITLE")}
          </a>
        </nav>
        <form action={logoutAction}>
          <button type="submit" className={`${buttonClasses.secondary} w-full`}>
            {t("AUTH.SIGN_OUT")}
          </button>
        </form>
      </div>
    </details>
  );
}
