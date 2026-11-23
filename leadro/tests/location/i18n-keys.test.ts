import { describe, expect, it } from "vitest";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { LOCATION_EVENT_KINDS, LOCATION_EXCEPTIONS, LOCATION_SOURCES } from "@/server/location";

/** Every language-neutral value the shifts / location API returns has a label in all three catalogs (clients render by key). */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

const expectedKeys = [
  ...LOCATION_EXCEPTIONS.map((code) => `LOCATION.EXCEPTION.${code}`),
  ...LOCATION_EVENT_KINDS.map((kind) => `LOCATION.KIND.${kind}`),
  ...LOCATION_SOURCES.map((source) => `LOCATION.SOURCE.${source}`),
  ...["UNVERIFIED", "WITHIN_RADIUS", "OUTSIDE_RADIUS", "MANAGER_VERIFIED"].map((verdict) => `LOCATION.VERIFICATION.${verdict}`),
  ...["ACTIVE", "ENDED"].map((status) => `SHIFT.STATUS.${status}`),
  ...["PENDING", "APPROVED", "REJECTED"].map((state) => `SHIFT.REVIEW.${state}`),
  "LOCATION.ACCURACY",
  "LOCATION.CONFIDENCE_NOTE",
  "LOCATION.COORDINATES_HIDDEN",
  "LOCATION.COORDINATES_PURGED",
  "SHIFT.NEEDS_POSITION_OR_REASON",
  "SHIFT.ALREADY_ACTIVE",
  "SHIFT.ENDED_BY_MANAGER",
];

describe("shift and location catalog keys", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has every SHIFT.* and LOCATION.* label the API can return`, () => {
      expect(expectedKeys.filter((key) => typeof catalog[key] !== "string" || (catalog[key] as string).length === 0)).toEqual([]);
    });
  }

  it("never words a position as proof (spec 17.2): the confidence note says estimate", () => {
    expect(enUS.messages["LOCATION.CONFIDENCE_NOTE" as keyof typeof enUS.messages]).toMatch(/estimate/i);
  });
});
