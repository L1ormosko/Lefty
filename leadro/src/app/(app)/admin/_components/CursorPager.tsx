import type { TranslateFn } from "@/lib/i18n";
import { buttonClasses } from "@/components/ui";

export interface CursorPagerProps {
  t: TranslateFn;
  /** Page path without query, e.g. `/admin/employees`. */
  path: string;
  /** Current filters (search, status, ...); kept on every link. */
  params: Record<string, string | undefined>;
  /** The cursor this page was opened with (undefined on the first page). */
  cursor: string | undefined;
  /** From the service's `page.nextCursor`; null on the last page. */
  nextCursor: string | null;
  /** Query parameter that carries the cursor; use distinct names when a page has two pagers. */
  cursorParam?: string;
}

function href(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/**
 * Forward-only pager for the services' keyset pagination: "first page" (when past it) and "next".
 * Renders nothing when everything fits on one page.
 */
export function CursorPager({ t, path, params, cursor, nextCursor, cursorParam = "cursor" }: CursorPagerProps) {
  if (!cursor && !nextCursor) return null;
  return (
    <nav aria-label={t("ADMIN.PAGINATION")} className="flex items-center justify-between gap-3 text-sm">
      {cursor ? (
        <a href={href(path, { ...params, [cursorParam]: undefined })} className={buttonClasses.secondary}>
          {t("ADMIN.PAGE_FIRST")}
        </a>
      ) : (
        <span />
      )}
      {nextCursor ? (
        <a href={href(path, { ...params, [cursorParam]: nextCursor })} className={buttonClasses.secondary} rel="next">
          {t("COMMON.NEXT")}
        </a>
      ) : null}
    </nav>
  );
}
