import { describe, expect, it } from "vitest";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { MATERIAL_COST_STATUSES } from "@/server/materials";

/** Every language-neutral value the materials API returns has a label in all three catalogs (clients render by key). */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

const COSTING_CODES = ["usage_already_costed", "usage_not_linked", "unit_mismatch", "no_effective_cost", "cost_out_of_range", "usage_linked_elsewhere"];

const expectedKeys = [
  ...MATERIAL_COST_STATUSES.map((status) => `MATERIAL.COST_STATUS.${status}`),
  ...COSTING_CODES.map((code) => `MATERIAL.COSTING.${code.toUpperCase()}`),
  "MATERIAL.COST.NOT_AFTER_CURRENT",
  "MATERIAL.COST.BEFORE_COSTED_USAGE",
  "MATERIAL.UNIT_LOCKED",
];

describe("materials i18n keys", () => {
  it.each(Object.keys(catalogs))("%s has every materials label", (locale) => {
    for (const key of expectedKeys) expect(catalogs[locale], key).toHaveProperty([key]);
  });
});
