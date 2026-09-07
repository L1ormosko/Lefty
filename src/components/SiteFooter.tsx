import Link from "next/link";
import { t } from "@/lib/labels";

/**
 * Shared footer: legal links and a support contact. Used on the marketing
 * page, auth pages, the legal pages themselves, and the three dashboards -
 * not on /explore, which is a fixed-viewport map shell with no scroll area
 * to put a footer in.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-ink-200 bg-white">
      <div className="mx-auto max-w-[1600px] px-4 py-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-500">
        <span className="font-medium text-ink-700">VELTO</span>
        <span className="hidden sm:inline">{t("footer.tagline")}</span>
        <nav className="flex flex-wrap gap-4 ms-0 sm:ms-auto" aria-label="מידע משפטי">
          <Link href="/takanon" className="hover:text-ink-800">
            {t("legal.terms")}
          </Link>
          <Link href="/terms" className="hover:text-ink-800">
            {t("legal.agreement")}
          </Link>
          <Link href="/privacy" className="hover:text-ink-800">
            {t("legal.privacy")}
          </Link>
          <a href={`mailto:${t("legal.supportEmail")}`} dir="ltr" className="hover:text-ink-800">
            {t("legal.supportEmail")}
          </a>
        </nav>
        <span className="w-full sm:w-auto text-xs text-ink-400">
          © {new Date().getFullYear()} VELTO — {t("footer.rights")}
        </span>
      </div>
    </footer>
  );
}
