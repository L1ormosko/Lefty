/**
 * Supported locales and text direction (spec §16.1, §16.4).
 * Adding a language = add it here, add a catalog JSON, and widen the DB CHECK constraints.
 * No business logic depends on a specific locale.
 */
export const SUPPORTED_LOCALES = ["en-US", "es-US", "he-IL"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Final fallback of every chain; its catalog is the source of truth for the key set. */
export const DEFAULT_LOCALE: Locale = "en-US";

export type TextDirection = "ltr" | "rtl";

const DIRECTION_BY_LOCALE: Record<Locale, TextDirection> = {
  "en-US": "ltr",
  "es-US": "ltr",
  "he-IL": "rtl",
};

/** Type guard for untrusted input (DB columns, headers, query strings). */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Value for the `dir` attribute of `<html>` / containers for this locale. */
export function directionOf(locale: Locale): TextDirection {
  return DIRECTION_BY_LOCALE[locale];
}

export function isRtl(locale: Locale): boolean {
  return directionOf(locale) === "rtl";
}
