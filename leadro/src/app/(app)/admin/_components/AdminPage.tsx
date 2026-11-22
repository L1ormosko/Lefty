import type { ReactNode } from "react";
import { EmptyState, buttonClasses, cx } from "@/components/ui";
import type { TranslateFn } from "@/lib/i18n";

export interface AdminPageProps {
  title: string;
  intro?: string;
  /** The ONE primary action of the screen (§24.3), shown at the end of the header. */
  primaryAction?: ReactNode;
  /** Optional tab links shown under the header (sections of one admin area). */
  tabs?: Array<{ href: string; label: string; isCurrent: boolean }>;
  children: ReactNode;
}

/** Common frame of every administration screen: heading, intro, primary action, optional tabs. */
export function AdminPage({ title, intro, primaryAction, tabs, children }: AdminPageProps) {
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          {intro ? <p className="mt-1 text-sm text-ink-muted">{intro}</p> : null}
        </div>
        {primaryAction ? <div className="flex flex-wrap items-center gap-2">{primaryAction}</div> : null}
      </header>
      {tabs ? (
        <nav aria-label={title} className="flex flex-wrap gap-1 border-b border-line">
          {tabs.map((tab) => (
            <a
              key={tab.href}
              href={tab.href}
              aria-current={tab.isCurrent ? "page" : undefined}
              className={cx(
                "-mb-px border-b-2 px-3 py-2 text-sm",
                tab.isCurrent ? "border-brand-600 font-semibold text-brand-700" : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {tab.label}
            </a>
          ))}
        </nav>
      ) : null}
      {children}
    </div>
  );
}

/** Shown instead of a screen the caller may not use (the service answered 403). */
export function AccessDenied({ t }: { t: TranslateFn }) {
  return (
    <div className="mx-auto max-w-3xl rounded border border-line bg-surface">
      <EmptyState title={t("ADMIN.ACCESS_DENIED_TITLE")} description={t("ADMIN.ACCESS_DENIED_DESCRIPTION")} />
    </div>
  );
}

/** A bordered white panel used for sections of a screen. */
export function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded border border-line bg-surface p-4">
      {title || action ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="text-lg font-semibold">{title}</h2> : <span />}
          {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Link styled as a secondary button. */
export function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={buttonClasses.secondary}>
      {children}
    </a>
  );
}
