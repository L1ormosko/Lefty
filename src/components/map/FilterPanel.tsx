"use client";

import { ASSET_TYPES, AVAILABILITY_STATES, CURRENCY } from "@/lib/constants";
import { t } from "@/lib/labels";
import { AvailabilityBadge } from "@/components/badges";
import { Button, inputClass, Num, cx } from "@/components/ui";
import type { Filters } from "./filters";

type Props = {
  filters: Filters;
  cities: { city: string; count: number }[];
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
  resultCount: number;
  onApply?: () => void;
  className?: string;
};

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function FilterPanel({ filters, cities, onChange, onReset, resultCount, onApply, className }: Props) {
  return (
    <div className={cx("flex flex-col h-full", className)}>
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <section>
          <label htmlFor="f-city" className="block text-sm font-medium text-ink-800 mb-2">
            {t("filter.city")}
          </label>
          <select
            id="f-city"
            className={inputClass}
            value={filters.city}
            onChange={(e) => onChange({ city: e.target.value })}
          >
            <option value="">{t("filter.allCities")}</option>
            {cities.map((c) => (
              <option key={c.city} value={c.city}>
                {c.city} ({c.count})
              </option>
            ))}
          </select>
        </section>

        <fieldset>
          <legend className="text-sm font-medium text-ink-800 mb-2">{t("filter.assetType")}</legend>
          <div className="space-y-1.5">
            {ASSET_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer">
                <input
                  type="checkbox"
                  className="size-4 rounded border-ink-300"
                  checked={filters.types.includes(type)}
                  onChange={() => onChange({ types: toggle(filters.types, type) })}
                />
                {t(`type.${type}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-ink-800 mb-2">{t("filter.availability")}</legend>
          <div className="space-y-1.5">
            {AVAILABILITY_STATES.filter((s) => s !== "INACTIVE").map((state) => (
              <label key={state} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="size-4 rounded border-ink-300"
                  checked={filters.availability.includes(state)}
                  onChange={() => onChange({ availability: toggle(filters.availability, state) })}
                />
                <AvailabilityBadge state={state} size="sm" />
              </label>
            ))}
          </div>
        </fieldset>

        <section>
          <p className="text-sm font-medium text-ink-800 mb-2">{t("filter.dates")}</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="f-start" className="block text-xs text-ink-500 mb-1">
                {t("common.from")}
              </label>
              <input
                id="f-start"
                type="date"
                dir="ltr"
                className={inputClass}
                value={filters.startDate}
                onChange={(e) => onChange({ startDate: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="f-end" className="block text-xs text-ink-500 mb-1">
                {t("common.to")}
              </label>
              <input
                id="f-end"
                type="date"
                dir="ltr"
                className={inputClass}
                value={filters.endDate}
                min={filters.startDate || undefined}
                onChange={(e) => onChange({ endDate: e.target.value })}
              />
            </div>
          </div>
        </section>

        <section>
          <p className="text-sm font-medium text-ink-800 mb-2">
            {t("filter.priceRange")} <span className="text-ink-500 font-normal">({CURRENCY})</span>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <input
              aria-label={t("filter.minPrice")}
              type="number"
              min={0}
              dir="ltr"
              placeholder={t("filter.minPrice")}
              className={inputClass}
              value={filters.minPrice}
              onChange={(e) => onChange({ minPrice: e.target.value })}
            />
            <input
              aria-label={t("filter.maxPrice")}
              type="number"
              min={0}
              dir="ltr"
              placeholder={t("filter.maxPrice")}
              className={inputClass}
              value={filters.maxPrice}
              onChange={(e) => onChange({ maxPrice: e.target.value })}
            />
          </div>
        </section>

        <section className="space-y-2 border-t border-ink-200 pt-4">
          <label className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer">
            <input
              type="checkbox"
              className="size-4 rounded border-ink-300"
              checked={filters.digitalOnly}
              onChange={(e) => onChange({ digitalOnly: e.target.checked })}
            />
            {t("filter.digitalOnly")}
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer">
            <input
              type="checkbox"
              className="size-4 rounded border-ink-300"
              checked={filters.verifiedOnly}
              onChange={(e) => onChange({ verifiedOnly: e.target.checked })}
            />
            {t("filter.verifiedOnly")}
          </label>
        </section>
      </div>

      <div className="border-t border-ink-200 p-3 flex items-center gap-2 bg-white">
        <Button variant="ghost" size="sm" onClick={onReset}>
          {t("map.clearFilters")}
        </Button>
        {onApply ? (
          <Button className="flex-1" onClick={onApply}>
            {t("map.showResults", { count: resultCount })}
          </Button>
        ) : (
          <span className="ms-auto text-sm text-ink-600">
            <Num>{resultCount}</Num> {t("common.results")}
          </span>
        )}
      </div>
    </div>
  );
}
