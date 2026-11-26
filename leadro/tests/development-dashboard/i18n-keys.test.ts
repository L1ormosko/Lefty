import { describe, expect, it } from "vitest";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";

/** The language-neutral codes the dashboard and customer feedback APIs return have a label in all three catalogs. */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

const expectedKeys = [
  ...["POSITIONED", "NOT_ENOUGH_DATA", "NOT_ENOUGH_PEERS", "LOWER_IS_BETTER"].map((code) => `PERFORMANCE.POSITION.${code}`),
  ...["STRENGTH", "DEVELOPMENT_OPPORTUNITY", "TYPICAL"].map((code) => `DEVELOPMENT.ASSESSMENT.${code}`),
  "DEVELOPMENT.DASHBOARD.NOT_A_SCORE",
  "DEVELOPMENT.DASHBOARD.SECTION_NOT_VISIBLE",
  "CUSTOMER_FEEDBACK.CHANNEL.MANUAL",
  "CUSTOMER_FEEDBACK.VOIDED",
  "CUSTOMER_FEEDBACK.ABOUT_JOB",
];

describe("development dashboard and customer feedback i18n keys", () => {
  it.each(Object.keys(catalogs))("%s has every label", (locale) => {
    for (const key of expectedKeys) expect(catalogs[locale], key).toHaveProperty([key]);
  });
});
