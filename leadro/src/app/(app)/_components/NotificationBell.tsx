import { focusRing } from "@/components/ui";
import type { TranslateFn } from "@/lib/i18n";

/**
 * Placeholder for the notification centre. There is no notification system yet (later phase), so
 * the panel says so truthfully and no badge or count is ever drawn.
 */
export function NotificationBell({ t }: { t: TranslateFn }) {
  return (
    <details className="relative">
      <summary
        className={`flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded border border-line-strong bg-surface ${focusRing}`}
      >
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
          <path d="M5 8a5 5 0 0 1 10 0c0 5 2 6 2 6H3s2-1 2-6" />
          <path d="M8.5 17a1.8 1.8 0 0 0 3 0" />
        </svg>
        <span className="sr-only">{t("SHELL.NOTIFICATIONS")}</span>
      </summary>
      <div className="absolute end-0 z-20 mt-2 w-72 rounded border border-line bg-surface p-4 text-sm shadow-overlay">
        <p className="font-semibold">{t("SHELL.NOTIFICATIONS")}</p>
        <p className="mt-1 text-ink-muted">{t("SHELL.NO_NOTIFICATIONS")}</p>
      </div>
    </details>
  );
}
