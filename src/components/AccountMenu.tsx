import Link from "next/link";
import { t } from "@/lib/labels";
import type { SessionUser } from "@/server/auth";
import { Num } from "./ui";
import { LogoutButton } from "./LogoutButton";

/**
 * One place for everything about the account.
 *
 * Counted on a signed-in dashboard screen before this existed: twelve
 * navigation controls, two of them duplicated. "בריף" and "התראות" each
 * appeared in the header AND in the sidebar; "לוח בקרה" sat in the header
 * pointing at the page the reader was already on; and "פרופיל" and "התראות"
 * were repeated in all three sidebars, although neither belongs to a section -
 * they belong to whoever is signed in.
 *
 * So they move here, and the sidebars lose two items each. The header keeps
 * what a visitor navigates by - the map and the brief - and everything about
 * the account folds behind the reader's own name, which is where people look
 * for it.
 *
 * Built on <details> rather than a dropdown: it opens on click, closes on
 * Escape, is reachable by keyboard and works before any JavaScript arrives -
 * the same reason Collapsible in ui.tsx is built that way. A menu that needs
 * hydration to open is a menu that is broken for the first second of every
 * page load.
 */
export function AccountMenu({
  user,
  unread,
  dashboardHref,
}: {
  user: SessionUser;
  unread: number;
  dashboardHref: string;
}) {
  const item =
    "flex items-center gap-2 px-3 min-h-11 sm:min-h-10 text-sm text-ink-700 hover:bg-ink-50";

  return (
    <details className="relative group">
      {/* No aria-label. The accessible name is the visible text - the reader's
          own name - which is what a screen reader should announce and what a
          voice control user would say. An aria-label of "my account" over it
          would mean the two disagree. */}
      <summary
        data-account-menu
        title={t("nav.account")}
        className="list-none [&::-webkit-details-marker]:hidden cursor-pointer inline-flex items-center gap-1.5 min-h-11 sm:min-h-0 sm:py-1.5 px-2 rounded-md text-sm text-ink-800 hover:bg-ink-100"
      >
        {/* First name only. The header is 56px and a full name with a company
            suffix pushes the map and brief links off a phone. */}
        <span className="max-w-[9rem] truncate">{user.name.split(" ")[0]}</span>
        {/* The unread count rides on the trigger, because a notification the
            reader has to open a menu to discover is a notification that does
            not arrive. */}
        {unread > 0 && (
          <span className="min-w-5 h-5 px-1 rounded-full bg-brand-600 text-white text-[11px] inline-flex items-center justify-center">
            <Num>{unread}</Num>
          </span>
        )}
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          className="size-4 text-ink-400 transition-transform group-open:rotate-180"
        >
          <path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </summary>

      {/* end-0 rather than left/right: the page is RTL and this has to hang
          from the same edge the trigger sits on in both directions. */}
      <div className="absolute end-0 top-full mt-1 w-56 rounded-lg border border-ink-200 bg-white shadow-raised py-1 z-40">
        <Link href={dashboardHref} className={item}>
          {t("nav.dashboard")}
        </Link>
        <Link href={`${dashboardHref}/notifications`} className={item}>
          <span>{t("nav.notifications")}</span>
          {unread > 0 && (
            <span className="ms-auto min-w-5 h-5 px-1 rounded-full bg-brand-600 text-white text-[11px] inline-flex items-center justify-center">
              <Num>{unread}</Num>
            </span>
          )}
        </Link>
        <Link href={`${dashboardHref}/profile`} className={item}>
          {t("dash.profile")}
        </Link>
        <div className="my-1 border-t border-ink-100" />
        <div className="px-1">
          <LogoutButton />
        </div>
      </div>
    </details>
  );
}
