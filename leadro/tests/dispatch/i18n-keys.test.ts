import { describe, expect, it } from "vitest";
import { CONFLICT_CODES, SCORING_FACTOR_KEYS, scoreCandidate } from "@/lib/dispatch-scoring";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { DISPATCH_MODES } from "@/server/dispatch";

/** Every language-neutral value the dispatch API returns has a label in all three catalogs (clients render by key). */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

const scored = [
  scoreCandidate({ employeeId: "a", distanceKm: 3, openJobCount: 1, completedOfTypeCount: 2, customerPreference: "PREFERRED" }),
  scoreCandidate({ employeeId: "b", distanceKm: null, openJobCount: 9, completedOfTypeCount: 0, customerPreference: "AVOID" }),
  scoreCandidate({ employeeId: "c", distanceKm: 99, openJobCount: 0, completedOfTypeCount: 0, customerPreference: null }),
];
const emittedKeys = scored.flatMap((candidate) => [...candidate.factors.map((factor) => factor.explanationKey), ...candidate.conflicts.map((conflict) => conflict.messageKey)]);

const expectedKeys = [
  ...new Set([
    ...emittedKeys,
    ...SCORING_FACTOR_KEYS.map((key) => `DISPATCH.FACTOR_NAME.${key}`),
    ...CONFLICT_CODES.map((code) => `DISPATCH.CONFLICT.${code}`),
    ...DISPATCH_MODES.map((mode) => `DISPATCH.MODE.${mode}`),
    ...["PENDING", "APPROVED", "MODIFIED", "REJECTED", "SUPERSEDED"].map((status) => `DISPATCH.STATUS.${status}`),
    "DISPATCH.STRAIGHT_LINE_ESTIMATE",
    "DISPATCH.NO_ELIGIBLE",
    "DISPATCH.MODE.NOT_AVAILABLE",
  ]),
];

describe("dispatch catalog keys", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has every DISPATCH.* label the API can return`, () => {
      expect(expectedKeys.filter((key) => typeof catalog[key] !== "string" || (catalog[key] as string).length === 0)).toEqual([]);
    });
  }
});
