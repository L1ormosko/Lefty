import Link from "next/link";
import { t } from "@/lib/labels";
import type { SessionUser } from "@/server/auth";
import { LinkButton } from "./ui";
import { AccountMenu } from "./AccountMenu";

function dashboardHref(role: SessionUser["role"]) {
  if (role === "MEDIA_OWNER") return "/owner";
  if (role === "ADMIN") return "/admin";
  return "/dashboard";
}

/** 44px on touch, compact on a pointer device. */
const TOUCH = "min-h-11 sm:min-h-0";

export function SiteHeader({ user, unread }: { user: SessionUser | null; unread: number }) {
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-ink-200">
      <div className="mx-auto max-w-[1600px] px-4 h-14 flex items-center gap-4">
        {/* The wordmark is a link home, and on a phone it was a 29px target -
            the smallest one in the product, on the control people reach for
            when they are lost. The row is 56px, so min-h-11 costs no layout. */}
        <Link
          href="/"
          className="inline-flex items-center min-h-11 sm:min-h-0 font-semibold text-lg tracking-tight text-ink-900 shrink-0"
        >
          VELTO
        </Link>
        <span className="hidden lg:block text-xs text-ink-500 border-s border-ink-200 ps-4">
          {t("app.tagline")}
        </span>

        <nav className="ms-auto flex items-center gap-1 sm:gap-2" aria-label="ניווט ראשי">
          <Link href="/explore" className="inline-flex items-center min-h-11 text-sm text-ink-700 hover:text-ink-900 px-2">
            {t("nav.explore")}
          </Link>
          <Link href="/brief" className="inline-flex items-center min-h-11 text-sm text-ink-700 hover:text-ink-900 px-2">
            {t("nav.brief")}
          </Link>
          {!user && (
            <Link href="/register?role=MEDIA_OWNER" className="hidden sm:block text-sm text-ink-700 hover:text-ink-900 px-2">
              {t("nav.listYourSpace")}
            </Link>
          )}
          {user ? (
            /* Three controls became one.
               The notifications link, the dashboard button and the logout
               button all lived out here, and two of them were repeated in
               every dashboard sidebar. They are all about the account rather
               than about the product, so they fold behind the reader's own
               name - see AccountMenu. The unread count still rides on the
               outside of it, because a badge inside a closed menu is not a
               notification. */
            <AccountMenu user={user} unread={unread} dashboardHref={dashboardHref(user.role)} />
          ) : (
            <>
              <LinkButton href="/login" variant="ghost" size="sm" className={TOUCH}>
                {t("nav.login")}
              </LinkButton>
              <LinkButton href="/register" size="sm" className={TOUCH}>
                {t("nav.register")}
              </LinkButton>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
