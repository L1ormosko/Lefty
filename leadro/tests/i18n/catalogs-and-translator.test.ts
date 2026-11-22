import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOGS,
  SUPPORTED_LOCALES,
  createTranslator,
  directionOf,
  isRtl,
  isSupportedLocale,
  resetMissingKeyWarnings,
} from "@/lib/i18n";
import { checkCatalogs } from "@/lib/i18n/check/catalog-check";
import { PERMISSION_ACTIONS } from "@/server/authz/permission-catalog";

describe("catalogs", () => {
  it("have identical key sets and placeholders across all locales", () => {
    expect(checkCatalogs(CATALOGS)).toEqual([]);
    const reference = Object.keys(CATALOGS["en-US"].messages).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(CATALOGS[locale].messages).sort()).toEqual(reference);
    }
  });

  it("detects missing keys, extra keys and placeholder drift", () => {
    const broken = structuredClone(CATALOGS);
    delete broken["es-US"].messages["COMMON.SAVE"];
    broken["he-IL"].messages["COMMON.EXTRA"] = "x";
    broken["he-IL"].messages["COMMON.PAGE_OF"] = "עמוד {page}";
    const problems = checkCatalogs(broken).join("\n");
    expect(problems).toContain('es-US: missing key "COMMON.SAVE"');
    expect(problems).toContain('he-IL: extra key "COMMON.EXTRA"');
    expect(problems).toContain('he-IL: key "COMMON.PAGE_OF" placeholders');
  });

  it("carry a version and real (non-English) translations", () => {
    for (const locale of SUPPORTED_LOCALES) expect(CATALOGS[locale].version).toBeGreaterThanOrEqual(1);
    expect(CATALOGS["es-US"].messages["JOB_STATUS.COMPLETED"]).toBe("Completado");
    expect(CATALOGS["he-IL"].messages["JOB_STATUS.COMPLETED"]).toBe("הושלמה");
    expect(CATALOGS["he-IL"].messages["COMMON.SAVE"]).toMatch(/[֐-׿]/);
  });

  it("cover every permission action and error code the platform emits", () => {
    for (const action of PERMISSION_ACTIONS) {
      expect(CATALOGS["en-US"].messages).toHaveProperty(`PERMISSION_ACTION.${action}`);
    }
    for (const code of [
      "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION_FAILED",
      "CONFLICT", "INVALID_STATE_TRANSITION", "RATE_LIMITED", "UNSUPPORTED_MEDIA_TYPE", "PAYLOAD_TOO_LARGE", "INTERNAL",
    ]) {
      expect(CATALOGS["en-US"].messages).toHaveProperty(`ERROR.${code}`);
    }
  });
});

describe("direction", () => {
  it("renders he-IL right-to-left and the others left-to-right", () => {
    expect(directionOf("he-IL")).toBe("rtl");
    expect(directionOf("en-US")).toBe("ltr");
    expect(directionOf("es-US")).toBe("ltr");
    expect(isRtl("he-IL")).toBe(true);
    expect(isRtl("es-US")).toBe(false);
  });

  it("recognises only supported locales", () => {
    expect(isSupportedLocale("he-IL")).toBe(true);
    expect(isSupportedLocale("fr-FR")).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });
});

describe("createTranslator", () => {
  beforeEach(() => resetMissingKeyWarnings());

  it("translates into the first locale of the chain", () => {
    expect(createTranslator({ localeChain: ["he-IL"] })("JOB_STATUS.COMPLETED")).toBe("הושלמה");
    expect(createTranslator({ localeChain: ["es-US"] })("COMMON.SAVE")).toBe("Guardar");
  });

  it("interpolates params and leaves unknown placeholders visible", () => {
    const t = createTranslator({ localeChain: ["en-US"] });
    expect(t("COMMON.PAGE_OF", { page: 2, total: 9 })).toBe("Page 2 of 9");
    expect(t("COMMON.PAGE_OF", { page: 2 })).toBe("Page 2 of {total}");
  });

  it("falls back along the chain, then to en-US, for keys a locale lacks", () => {
    const onMissingKey = vi.fn();
    // Simulate a locale that lacks a key by using a tenant-only key present only in the 2nd locale.
    const t = createTranslator({
      localeChain: ["he-IL", "es-US"],
      overrides: { "es-US": { "CUSTOM.ONLY_ES": "solo es" }, "en-US": { "CUSTOM.ONLY_EN": "only en" } },
      onMissingKey,
    });
    expect(t("CUSTOM.ONLY_ES")).toBe("solo es");
    expect(t("CUSTOM.ONLY_EN")).toBe("only en");
    expect(onMissingKey).toHaveBeenCalledTimes(2);
    expect(onMissingKey).toHaveBeenCalledWith({ locale: "he-IL", key: "CUSTOM.ONLY_ES" });
  });

  it("never throws for an unknown key: renders the key and reports once", () => {
    const onMissingKey = vi.fn();
    const t = createTranslator({ localeChain: ["es-US"], onMissingKey });
    expect(t("NOPE.MISSING")).toBe("NOPE.MISSING");
    expect(t("NOPE.MISSING")).toBe("NOPE.MISSING");
    expect(onMissingKey).toHaveBeenCalledTimes(1);
  });

  it("logs a missing key once in dev and stays silent in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = createTranslator({ localeChain: ["en-US"] });
    t("DEV.MISSING");
    createTranslator({ localeChain: ["en-US"] })("DEV.MISSING");
    expect(warn).toHaveBeenCalledTimes(1);

    resetMissingKeyWarnings();
    warn.mockClear();
    vi.stubEnv("NODE_ENV", "production");
    createTranslator({ localeChain: ["en-US"] })("DEV.MISSING");
    expect(warn).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it("lets tenant overrides win over the built-in text of the same locale", () => {
    const t = createTranslator({
      localeChain: ["es-US"],
      overrides: { "es-US": { "COMMON.SAVE": "Salvar" } },
    });
    expect(t("COMMON.SAVE")).toBe("Salvar");
    expect(t("COMMON.CANCEL")).toBe("Cancelar");
  });
});
