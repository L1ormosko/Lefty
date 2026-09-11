import Link from "next/link";
import { t } from "@/lib/labels";
import type { SessionUser } from "@/server/auth";
import { LinkButton, Num } from "./ui";
import { LogoutButton } from "./LogoutButton";

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
        <Link href="/" className="font-semibold text-lg tracking-tight text-ink-900 shrink-0">
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
            <>
              <Link
                href={`${dashboardHref(user.role)}/notifications`}
                className="relative inline-flex items-center min-h-11 text-sm text-ink-700 hover:text-ink-900 px-2"
              >
                {t("nav.notifications")}
                {unread > 0 && (
                  <span className="absolute -top-1 -start-1 min-w-5 h-5 px-1 rounded-full bg-brand-600 text-white text-[11px] flex items-center justify-center">
                    <Num>{unread}</Num>
                  </span>
                )}
              </Link>
              <LinkButton href={dashboardHref(user.role)} variant="secondary" size="sm" className={TOUCH}>
                {t("nav.dashboard")}
              </LinkButton>
              <LogoutButton />
            </>
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
