import { DEFAULT_LOCALE, SUPPORTED_LOCALES, isSupportedLocale, type Locale } from "@/lib/i18n";

/** Cookie remembering the language chosen on pages where nobody is signed in (§16.2). */
export const LOCALE_COOKIE_NAME = "leadro_locale";

/**
 * Best supported locale for an `Accept-Language` header, or null when nothing matches.
 * Matches the exact tag first (`es-US`), then the primary language (`es`, `es-MX` -> `es-US`).
 * Entries are ranked by their q-value; ties keep header order.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isNaN(q) ? 0 : q, index };
    })
    .filter((entry) => entry.tag !== "" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag } of ranked) {
    const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const primary = tag.split("-")[0];
    // "iw" is the legacy ISO code some browsers still send for Hebrew.
    const language = primary === "iw" ? "he" : primary;
    const sameLanguage = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase().split("-")[0] === language);
    if (sameLanguage) return sameLanguage;
  }
  return null;
}

/**
 * Locale for a request with no signed-in user: the explicit cookie choice wins over the browser
 * preference, which wins over the platform default (§16.2).
 */
export function resolveAnonymousLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (isSupportedLocale(cookieValue)) return cookieValue;
  return localeFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}
