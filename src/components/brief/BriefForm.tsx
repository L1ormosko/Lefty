/**
 * The brief form.
 *
 * A plain GET form on purpose. It needs no JavaScript, every shortlist has a
 * shareable URL, and the back button does what a back button should - the same
 * decision the map filters already made.
 */
import { t } from "@/lib/labels";
import { ASSET_TYPES, LOCATION_TAGS, CURRENCY } from "@/lib/constants";
import { Card, Field, buttonClass, inputClass, textareaClass } from "@/components/ui";
import type { Brief } from "@/lib/brief";

function CheckGrid({
  name,
  values,
  selected,
  labelKey,
}: {
  name: string;
  values: readonly string[];
  selected: string[];
  labelKey: (v: string) => string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value, i) => {
        // City names contain spaces, and an id with a space is not a valid
        // HTML id - it also cannot be targeted by a CSS selector, which is how
        // this was found. The index keeps two cities that slugify the same
        // apart.
        const id = `${name}-${i}-${value.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        const isOn = selected.includes(value);
        return (
          <span key={value}>
            <input
              type="checkbox"
              id={id}
              name={name}
              value={value}
              defaultChecked={isOn}
              className="peer sr-only"
            />
            <label
              htmlFor={id}
              className={
                "cursor-pointer inline-flex items-center rounded-full border px-3 py-1.5 text-xs " +
                "border-ink-300 text-ink-700 hover:bg-ink-50 " +
                "peer-checked:border-brand-600 peer-checked:bg-brand-50 peer-checked:text-brand-700 " +
                "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2"
              }
            >
              {labelKey(value)}
            </label>
          </span>
        );
      })}
    </div>
  );
}

export function BriefForm({
  brief,
  text,
  cities,
}: {
  brief: Brief;
  text: string;
  cities: { city: string; count: number }[];
}) {
  return (
    <Card className="p-4">
      <form method="GET" action="/brief" className="space-y-4">
        <Field label={t("brief.freeText")} htmlFor="text">
          <textarea
            id="text"
            name="text"
            rows={3}
            defaultValue={text}
            placeholder={t("brief.freeTextPlaceholder")}
            className={textareaClass}
            maxLength={1000}
          />
        </Field>

        <div className="grid sm:grid-cols-3 gap-3">
          <Field label={t("brief.startDate")} htmlFor="startDate">
            <input
              type="date"
              id="startDate"
              name="startDate"
              defaultValue={brief.startDate ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label={t("brief.endDate")} htmlFor="endDate">
            <input
              type="date"
              id="endDate"
              name="endDate"
              defaultValue={brief.endDate ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label={`${t("brief.budget")} (${CURRENCY})`} htmlFor="budget">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              id="budget"
              name="budget"
              defaultValue={brief.budget ?? ""}
              className={inputClass}
            />
          </Field>
        </div>

        {cities.length > 0 && (
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-ink-800">{t("brief.cities")}</span>
            {/* Only cities that actually have inventory - never a fixed list. */}
            <CheckGrid
              name="cities"
              values={cities.map((c) => c.city)}
              selected={brief.cities}
              labelKey={(v) => v}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-ink-800">{t("brief.types")}</span>
          <CheckGrid
            name="types"
            values={ASSET_TYPES}
            selected={brief.assetTypes}
            labelKey={(v) => t(`type.${v}`)}
          />
        </div>

        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-ink-800">{t("brief.tags")}</span>
          <CheckGrid
            name="tags"
            values={LOCATION_TAGS}
            selected={brief.locationTags}
            labelKey={(v) => t(`tag.${v}`)}
          />
          <p className="text-xs text-ink-500">{t("tag.declared")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" name="digitalOnly" value="1" defaultChecked={brief.digitalOnly} />
            {t("filter.digitalOnly")}
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" name="verifiedOnly" value="1" defaultChecked={brief.verifiedOnly} />
            {t("filter.verifiedOnly")}
          </label>
          <div className="ms-auto flex items-center gap-2">
            <a href="/brief" className={buttonClass("ghost", "sm")}>
              {t("brief.reset")}
            </a>
            <button type="submit" className={buttonClass("primary", "md")}>
              {t("brief.submit")}
            </button>
          </div>
        </div>
      </form>
    </Card>
  );
}
