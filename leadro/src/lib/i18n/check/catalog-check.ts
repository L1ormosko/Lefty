import { DEFAULT_LOCALE, type Locale } from "../locales";
import type { MessageCatalog } from "../catalogs";

const KEY_FORMAT = /^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)+$/;
const PLACEHOLDER = /\{(\w+)\}/g;

/** Human-readable problems; an empty array means the catalogs are consistent. */
export function checkCatalogs(catalogs: Record<Locale, MessageCatalog>): string[] {
  const problems: string[] = [];
  const reference = catalogs[DEFAULT_LOCALE];
  const referenceKeys = Object.keys(reference.messages);

  for (const [locale, catalog] of Object.entries(catalogs) as Array<[Locale, MessageCatalog]>) {
    if (catalog.locale !== locale) problems.push(`${locale}: file declares locale "${catalog.locale}"`);
    if (!Number.isInteger(catalog.version) || catalog.version < 1) {
      problems.push(`${locale}: "version" must be a positive integer`);
    }
    for (const key of Object.keys(catalog.messages)) {
      if (!KEY_FORMAT.test(key)) problems.push(`${locale}: key "${key}" is not DOMAIN.UPPER_SNAKE`);
    }
    if (locale === DEFAULT_LOCALE) continue;

    for (const key of referenceKeys) {
      if (!(key in catalog.messages)) problems.push(`${locale}: missing key "${key}"`);
    }
    for (const key of Object.keys(catalog.messages)) {
      if (!(key in reference.messages)) problems.push(`${locale}: extra key "${key}" (not in ${DEFAULT_LOCALE})`);
    }
    // A translation that drops or renames {placeholders} would render broken text at runtime.
    for (const key of referenceKeys) {
      const translated = catalog.messages[key];
      if (translated === undefined) continue;
      if (translated.trim() === "") problems.push(`${locale}: key "${key}" is empty`);
      const expected = placeholdersOf(reference.messages[key]).join(",");
      const actual = placeholdersOf(translated).join(",");
      if (expected !== actual) {
        problems.push(`${locale}: key "${key}" placeholders {${actual}} differ from ${DEFAULT_LOCALE} {${expected}}`);
      }
    }
  }
  return problems;
}

function placeholdersOf(message: string): string[] {
  return [...message.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
}
