import Link from "next/link";
import { t } from "@/lib/labels";
import { Num } from "@/components/ui";

/**
 * Paging for the list screens.
 *
 * Offset paging, on purpose. Cursor paging is the better answer for an
 * infinite feed under heavy write load; these are administrative lists sorted
 * newest-first, read by one person at a time, where "go to page 3" is a thing
 * someone actually wants and a stable total is worth showing. The cost of the
 * OFFSET is a count query and a scan that is bounded by the page number, which
 * at this size is nothing.
 *
 * It is a link, not a button: a page of a list is a location, so it survives a
 * refresh, a back button and being pasted to a colleague.
 */
export const PAGE_SIZE = 25;

/** `?page=` as a sane 1-based number. Anything unparseable is page one. */
export function pageFromParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

export function skipFor(page: number): number {
  return (page - 1) * PAGE_SIZE;
}

export function Pager({
  page,
  total,
  basePath,
  params,
}: {
  page: number;
  total: number;
  basePath: string;
  /** Any filters that must survive paging, e.g. the admin queue's tab. */
  params?: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;

  const href = (target: number) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value) qs.set(key, value);
    }
    if (target > 1) qs.set("page", String(target));
    const query = qs.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  const linkClass =
    "rounded-md border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50";
  const mutedClass = "rounded-md border border-ink-100 px-3 py-1.5 text-sm text-ink-300";

  return (
    <nav className="mt-4 flex items-center justify-between gap-3" aria-label={t("pager.label")}>
      {page > 1 ? (
        <Link href={href(page - 1)} className={linkClass} rel="prev">
          {t("pager.previous")}
        </Link>
      ) : (
        <span className={mutedClass} aria-disabled="true">
          {t("pager.previous")}
        </span>
      )}

      <span className="text-sm text-ink-600">
        {t("pager.position", { page: `⁨${page}⁩`, pages: `⁨${pages}⁩` })}
        <span className="text-ink-400">
          {" · "}
          <Num>{total}</Num> {t("common.results")}
        </span>
      </span>

      {page < pages ? (
        <Link href={href(page + 1)} className={linkClass} rel="next">
          {t("pager.next")}
        </Link>
      ) : (
        <span className={mutedClass} aria-disabled="true">
          {t("pager.next")}
        </span>
      )}
    </nav>
  );
}
