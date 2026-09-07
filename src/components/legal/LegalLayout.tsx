import Link from "next/link";
import { t } from "@/lib/labels";
import { SiteFooter } from "@/components/SiteFooter";

/** Shared shell for the three legal documents: title, last-updated, and cross-links. */
export function LegalLayout({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14 flex-1">
        <h1 className="text-2xl sm:text-3xl font-semibold text-ink-900">{title}</h1>
        <p className="mt-1 text-sm text-ink-500">
          {t("legal.lastUpdated")}: <span className="num">{lastUpdated}</span>
        </p>

        <article className="mt-8 space-y-6 text-ink-800 leading-relaxed">{children}</article>

        <nav className="mt-12 pt-6 border-t border-ink-200 flex flex-wrap gap-4 text-sm">
          <Link href="/takanon" className="text-brand-600 hover:underline">
            {t("legal.terms")}
          </Link>
          <Link href="/terms" className="text-brand-600 hover:underline">
            {t("legal.agreement")}
          </Link>
          <Link href="/privacy" className="text-brand-600 hover:underline">
            {t("legal.privacy")}
          </Link>
        </nav>
      </main>
      <SiteFooter />
    </>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-ink-900 mb-2">{heading}</h2>
      <div className="space-y-3 text-[15px]">{children}</div>
    </section>
  );
}
