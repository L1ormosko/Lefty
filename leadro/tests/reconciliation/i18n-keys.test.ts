import { describe, expect, it } from "vitest";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import {
  RECONCILIATION_EXCEPTION_KINDS,
  RECONCILIATION_EXCEPTION_STATUSES,
  RECONCILIATION_FAILURE_CODES,
  RECONCILIATION_FINDING_CODES,
  RECONCILIATION_RUN_STATUSES,
} from "@/lib/reconciliation-rules";

/** Every language-neutral value the reconciliation API returns has a label in all three catalogs. */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

const expectedKeys = [
  ...RECONCILIATION_RUN_STATUSES.map((status) => `FINANCE.RECONCILIATION.RUN.STATUS.${status}`),
  ...["TENANT", "LEGAL_ENTITY"].map((coverage) => `FINANCE.RECONCILIATION.RUN.COVERAGE.${coverage}`),
  ...RECONCILIATION_FAILURE_CODES.map((code) => `FINANCE.RECONCILIATION.RUN.FAILURE.${code.toUpperCase()}`),
  ...RECONCILIATION_EXCEPTION_KINDS.map((kind) => `FINANCE.RECONCILIATION.EXCEPTION.KIND.${kind}`),
  ...RECONCILIATION_EXCEPTION_STATUSES.map((status) => `FINANCE.RECONCILIATION.EXCEPTION.STATUS.${status}`),
  ...RECONCILIATION_FINDING_CODES.map((code) => `FINANCE.RECONCILIATION.EXCEPTION.CODE.${code.toUpperCase()}`),
  "FINANCE.RECONCILIATION.MONEY_REDACTED",
  "FINANCE.RECONCILIATION.SUMMARY.COVERAGE.TENANT",
  "FINANCE.RECONCILIATION.SUMMARY.COVERAGE.SCOPE",
  ...["period_empty", "period_too_long", "invalid_transition", "exception_changed", "assignee_not_eligible"].map(
    (code) => `FINANCE.ERROR.RECONCILIATION.${code.toUpperCase()}`,
  ),
];

describe("reconciliation catalog keys", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has every FINANCE.RECONCILIATION.* label the API can return`, () => {
      expect(expectedKeys.filter((key) => typeof catalog[key] !== "string" || (catalog[key] as string).length === 0)).toEqual([]);
    });
  }
});
