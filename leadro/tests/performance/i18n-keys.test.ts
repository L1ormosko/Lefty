import { describe, expect, it } from "vitest";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { METRIC_BREAKDOWNS, METRIC_KIND_CATALOG, METRIC_KINDS } from "@/lib/performance-formulas";
import { DEFINITION_STATUSES } from "@/server/performance";

/** Every language-neutral value the performance API returns has a label in all three catalogs (clients render by key). */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

const ERROR_CODES = ["invalid_params", "key_taken", "open_version_exists", "definition_has_values", "publication_policy_missing"];

const expectedKeys = [
  ...METRIC_KINDS.map((kind) => `PERFORMANCE.KIND.${kind}`),
  ...METRIC_KINDS.map((kind) => `PERFORMANCE.FORMULA.${kind}`),
  ...METRIC_KINDS.map((kind) => `PERFORMANCE.DIMENSION.${METRIC_KIND_CATALOG[kind].dimension}`),
  ...DEFINITION_STATUSES.map((status) => `PERFORMANCE.DEFINITION_STATUS.${status}`),
  ...METRIC_BREAKDOWNS.map((breakdown) => `PERFORMANCE.BREAKDOWN.${breakdown}`),
  ...ERROR_CODES.map((code) => `PERFORMANCE.ERROR.${code.toUpperCase()}`),
  "PERFORMANCE.NOT_ENOUGH_DATA",
  "PERFORMANCE.SAMPLE",
  "APPROVAL.SUBJECT.PERFORMANCE_METRIC_DEFINITION",
];

describe("performance i18n keys", () => {
  it.each(Object.keys(catalogs))("%s has every performance label", (locale) => {
    for (const key of expectedKeys) expect(catalogs[locale], key).toHaveProperty([key]);
  });
});
