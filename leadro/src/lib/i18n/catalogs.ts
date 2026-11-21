import enUS from "./catalogs/en-US.json";
import esUS from "./catalogs/es-US.json";
import heIL from "./catalogs/he-IL.json";
import type { Locale } from "./locales";

/** Shape of every catalog file. `version` is bumped whenever existing wording changes (§16.6). */
export interface MessageCatalog {
  locale: Locale;
  version: number;
  messages: Record<string, string>;
}

/**
 * Every key in the en-US catalog. Components call `t()` with this type, so a typo in a key is a
 * compile error. Parity of the other catalogs is enforced by `npm run i18n:check`.
 */
export type MessageKey = keyof typeof enUS.messages;

export const CATALOGS: Record<Locale, MessageCatalog> = {
  "en-US": enUS as MessageCatalog,
  "es-US": esUS as MessageCatalog,
  "he-IL": heIL as MessageCatalog,
};

export function getCatalog(locale: Locale): MessageCatalog {
  return CATALOGS[locale];
}
