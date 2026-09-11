/**
 * How a price is put into words. One place.
 *
 * `<Price>` in components/ui.tsx exists precisely so the currency position,
 * the thousands separator and the LTR isolation are decided once - and yet the
 * headline "from X per month, or X per week, or not published" line was still
 * written out by hand in three files: the explore result card, the brief match
 * card, and the MapLibre popup. The popup is the reason it kept happening: it
 * builds an HTML string, so it cannot render a React component and had no
 * choice but to re-implement the logic.
 *
 * So the decision - which rate to quote and how to word it - lives here as a
 * pure function, and both the component and the string builder call it. Pure
 * means node-vitest can cover it, which is the only kind of test this project
 * can run against UI logic.
 */
import { CURRENCY } from "./constants";
import { t } from "./labels";

export type RateSource = "monthly" | "weekly" | "none";

export type PriceLine = {
  /** Ready to render as text. Already carries the currency and the period. */
  text: string;
  /** Which published rate this came from, so a caller can style "none" differently. */
  source: RateSource;
  /** The number itself, for a caller that wants to render it through <Price>. */
  amount: number | null;
  /** "חודש" / "שבוע", or null when nothing is published. */
  per: string | null;
};

/** A shekel amount with a Hebrew thousands separator. */
export function formatAmount(amount: number): string {
  return `${CURRENCY}${amount.toLocaleString("he-IL")}`;
}

/**
 * The headline rate for a listing.
 *
 * Monthly wins when both are published: it is the figure owners quote and the
 * one the price filter searches on. When neither is published the answer is
 * "the owner did not publish a price" - never a zero, and never the other
 * side's number dressed up as this one.
 */
export function priceLine(asset: {
  priceMonthly?: number | null;
  priceWeekly?: number | null;
}): PriceLine {
  if (asset.priceMonthly != null) {
    return {
      text: `${t("asset.priceFrom")}${formatAmount(asset.priceMonthly)} / ${t("common.perMonth")}`,
      source: "monthly",
      amount: asset.priceMonthly,
      per: t("common.perMonth"),
    };
  }
  if (asset.priceWeekly != null) {
    return {
      text: `${t("asset.priceFrom")}${formatAmount(asset.priceWeekly)} / ${t("common.perWeek")}`,
      source: "weekly",
      amount: asset.priceWeekly,
      per: t("common.perWeek"),
    };
  }
  return {
    text: t("asset.priceNotPublished"),
    source: "none",
    amount: null,
    per: null,
  };
}
