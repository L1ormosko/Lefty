import { CATALOGS, type MessageKey } from "./catalogs";
import { DEFAULT_LOCALE, type Locale } from "./locales";

export type TranslationParams = Record<string, string | number>;

/** Tenant overrides keyed by locale then message key. Only REVIEWED overrides may be passed in. */
export type TranslationOverrides = Partial<Record<Locale, Record<string, string>>>;

export interface TranslatorOptions {
  /**
   * Locales to try in order (user → branch → company; en-US is always appended). The first entry
   * is the display locale; later ones only supply keys the earlier ones lack.
   */
  localeChain: readonly Locale[];
  /** Reviewed tenant overrides (§16.6). Win over the built-in catalog of the same locale. */
  overrides?: TranslationOverrides;
  /** Called once per (locale, key) when the display locale lacks a key. Defaults to a dev-only console warning. */
  onMissingKey?: (info: { locale: Locale; key: string }) => void;
}

export type TranslateFn = (key: MessageKey | (string & {}), params?: TranslationParams) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replaces `{name}` placeholders. An unknown placeholder is left visible rather than hidden. */
export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

const warnedMissing = new Set<string>();

/** Default missing-key reporter: noisy in dev/test only, silent in production, once per key. */
function warnMissingKeyInDev({ locale, key }: { locale: Locale; key: string }): void {
  if (process.env.NODE_ENV === "production") return;
  const id = `${locale}:${key}`;
  if (warnedMissing.has(id)) return;
  warnedMissing.add(id);
  console.warn(`[i18n] missing translation: ${id}`);
}

/** Test hook: forget which missing keys were already logged. */
export function resetMissingKeyWarnings(): void {
  warnedMissing.clear();
}

/**
 * Builds `t(key, params)`. Lookup order: for each locale in the chain, tenant override then
 * built-in catalog. If no locale has the key the key itself is returned, so the UI never renders
 * `undefined` or throws (§16.6 missing-key handling).
 */
export function createTranslator(options: TranslatorOptions): TranslateFn {
  const chain = [...new Set<Locale>([...options.localeChain, DEFAULT_LOCALE])];
  const displayLocale = chain[0];
  const report = options.onMissingKey ?? warnMissingKeyInDev;
  const reported = new Set<string>();

  function reportOnce(key: string): void {
    if (reported.has(key)) return;
    reported.add(key);
    report({ locale: displayLocale, key });
  }

  return (key, params) => {
    for (const locale of chain) {
      const text = options.overrides?.[locale]?.[key] ?? CATALOGS[locale].messages[key];
      if (text !== undefined) {
        if (locale !== displayLocale) reportOnce(key);
        return interpolate(text, params);
      }
    }
    reportOnce(key);
    return key;
  };
}
