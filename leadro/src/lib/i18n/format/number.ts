import type { Locale } from "../locales";

/** Locale-aware decimal number using the locale's separators and digits. */
export function formatNumber(
  value: number | bigint,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** Fraction (0.256) as a percentage ("25.6%"). */
export function formatPercent(fraction: number, locale: Locale, fractionDigits = 1): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(fraction);
}
