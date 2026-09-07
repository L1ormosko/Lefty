import Link from "next/link";
import { cx } from "./ui";
import { SiteFooter } from "./SiteFooter";

export type NavItem = { href: string; label: string; badge?: number };

export function DashboardShell({
  title,
  nav,
  current,
  action,
  children,
}: {
  title: string;
  nav: NavItem[];
  current: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 flex-1">
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <h1 className="text-xl font-semibold text-ink-900">{title}</h1>
          {action && <div className="ms-auto">{action}</div>}
        </div>
        <div className="grid lg:grid-cols-[220px_1fr] gap-6 items-start">
          <nav aria-label={title} className="lg:sticky lg:top-20">
            <ul className="flex lg:flex-col gap-1 overflow-x-auto pb-1">
              {nav.map((item) => {
                const active = current === item.href;
                return (
                  <li key={item.href} className="shrink-0">
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cx(
                        "flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap",
                        active ? "bg-ink-900 text-white" : "text-ink-700 hover:bg-ink-100"
                      )}
                    >
                      <span>{item.label}</span>
                      {item.badge ? (
                        <span
                          className={cx(
                            "ms-auto inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full text-[11px]",
                            active ? "bg-white/20" : "bg-brand-600 text-white"
                          )}
                        >
                          {item.badge}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="min-w-0">{children}</div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

export function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="font-semibold text-ink-900">{title}</h2>
        {action && <div className="ms-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}
