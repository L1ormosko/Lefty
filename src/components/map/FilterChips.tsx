"use client";

/**
 * The applied filters, visible and individually removable.
 *
 * Before this the only sign that anything was filtered was a number on the
 * mobile filter button — and that number was wrong, because it counted a whole
 * array of selected asset types as one. You could not see what was on without
 * opening the panel, and you could not turn one thing off without going in.
 */
import { t } from "@/lib/labels";
import { cx } from "@/components/ui";
import type { Chip, Filters } from "./filters";

/**
 * A chip's text. City names and free text are the user's own words and must
 * not be run through the dictionary, where they would come back as themselves
 * only by accident of the unknown-key fallback.
 */
export function chipText(chip: Chip): string {
  return chip.literal ? chip.label : t(chip.label);
}

export function FilterChips({
  chips,
  onClear,
  onClearAll,
  className,
}: {
  chips: Chip[];
  onClear: (patch: Partial<Filters>) => void;
  onClearAll: () => void;
  className?: string;
}) {
  if (chips.length === 0) return null;

  return (
    <div className={cx("flex flex-wrap items-center gap-1.5", className)}>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={() => onClear(chip.clear)}
          className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 ps-2.5 pe-2 py-1 text-xs text-brand-700 hover:bg-brand-100 transition-colors"
          // The label alone reads as a statement; the accessible name has to
          // say that pressing this removes it.
          aria-label={`${t("map.removeFilter")}: ${chipText(chip)}`}
        >
          <span>{chipText(chip)}</span>
          <span aria-hidden="true" className="text-brand-500 text-sm leading-none">
            ×
          </span>
        </button>
      ))}

      {/* Only worth offering once there is more than one thing to clear. */}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs text-ink-600 hover:text-ink-900 underline underline-offset-2 px-1"
        >
          {t("map.clearFilters")}
        </button>
      )}
    </div>
  );
}
