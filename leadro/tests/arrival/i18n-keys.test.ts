import { describe, expect, it } from "vitest";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { NOTIFICATION_EVENTS } from "@/server/notifications";
import { ARRIVAL_CONFIDENCES } from "@/server/arrival";

/** Every language-neutral value the arrival API returns has a label in all three catalogs (clients render by key). */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

const expectedKeys = [
  ...["RECORDED", "PENDING_MANAGER_REVIEW", "MANAGER_VERIFIED", "MANAGER_REJECTED"].map((status) => `ARRIVAL.STATUS.${status}`),
  ...["TECHNICIAN", "GEOFENCE", "MANAGER"].map((method) => `ARRIVAL.METHOD.${method}`),
  ...ARRIVAL_CONFIDENCES.map((confidence) => `ARRIVAL.CONFIDENCE.${confidence}`),
  ...["OUTSIDE_RADIUS", "POOR_ACCURACY", "NO_POSITION", "ADDRESS_WITHOUT_COORDINATES"].map((reason) => `ARRIVAL.REVIEW_REASON.${reason}`),
  "ARRIVAL.NOT_EN_ROUTE",
  "ARRIVAL.NOT_ARRIVED",
  "ARRIVAL.REJECTED_BLOCKS_START",
  "ARRIVAL.ALREADY_DECIDED",
  "ARRIVAL.DISTANCE_NOTE",
  "ARRIVAL.NAVIGATION_OPENED_NOTE",
  `${NOTIFICATION_EVENTS["job.arrival_unverified"].templateKey}.TITLE`,
  `${NOTIFICATION_EVENTS["job.arrival_unverified"].templateKey}.BODY`,
];

describe("arrival catalog keys", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has every ARRIVAL.* label the API can return`, () => {
      expect(expectedKeys.filter((key) => typeof catalog[key] !== "string" || (catalog[key] as string).length === 0)).toEqual([]);
    });
  }
});
