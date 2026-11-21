import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage, resolveAnonymousLocale } from "@/app/_lib/locale-negotiation";

describe("localeFromAcceptLanguage", () => {
  it("returns null for a missing header or unsupported languages", () => {
    expect(localeFromAcceptLanguage(null)).toBeNull();
    expect(localeFromAcceptLanguage("fr-FR,de;q=0.8")).toBeNull();
  });

  it("matches the exact tag, then the primary language", () => {
    expect(localeFromAcceptLanguage("he-IL")).toBe("he-IL");
    expect(localeFromAcceptLanguage("es-MX")).toBe("es-US");
    expect(localeFromAcceptLanguage("en-GB")).toBe("en-US");
  });

  it("orders by q-value and treats the legacy 'iw' code as Hebrew", () => {
    expect(localeFromAcceptLanguage("en;q=0.3,es;q=0.9")).toBe("es-US");
    expect(localeFromAcceptLanguage("iw")).toBe("he-IL");
    expect(localeFromAcceptLanguage("he;q=0,en;q=0.5")).toBe("en-US");
  });
});

describe("resolveAnonymousLocale", () => {
  it("prefers a valid cookie, ignores an invalid one, and falls back to en-US", () => {
    expect(resolveAnonymousLocale("es-US", "he-IL")).toBe("es-US");
    expect(resolveAnonymousLocale("xx-XX", "he-IL")).toBe("he-IL");
    expect(resolveAnonymousLocale(undefined, null)).toBe("en-US");
  });
});
