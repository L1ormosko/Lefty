import type { ReactNode } from "react";
import { TextInput, buttonClasses } from "@/components/ui";
import type { TranslateFn } from "@/lib/i18n";

export interface SearchFormProps {
  t: TranslateFn;
  /** Current search text. */
  search: string | undefined;
  /** Extra filter controls (selects) rendered before the button; they carry their own `name`. */
  children?: ReactNode;
  /** Other query values to keep while searching (but not the cursor: a new search starts at page one). */
  hidden?: Record<string, string | undefined>;
}

/**
 * Search/filter bar as a plain GET form: filters live in the URL, so they survive reloads, can be
 * shared and need no client state. Submitting always returns to the first page.
 */
export function SearchForm({ t, search, children, hidden = {} }: SearchFormProps) {
  return (
    <form role="search" method="get" className="flex flex-wrap items-end gap-2">
      {Object.entries(hidden).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
      <div className="min-w-48 flex-1">
        <label htmlFor="admin-search" className="sr-only">
          {t("COMMON.SEARCH")}
        </label>
        <TextInput id="admin-search" type="search" name="search" defaultValue={search} placeholder={t("COMMON.SEARCH")} />
      </div>
      {children}
      <button type="submit" className={buttonClasses.secondary}>
        {t("COMMON.FILTER")}
      </button>
    </form>
  );
}
