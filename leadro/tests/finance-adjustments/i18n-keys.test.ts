import { describe, expect, it } from "vitest";
import { ADJUSTMENT_REASON_CODES, CHARGEBACK_TRANSITIONS, CHARGEBACK_WRITE_OFF_REASON_CODE, REVIEW_FLAG_REASONS } from "@/lib/finance-correction-rules";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";

/** Every language-neutral value the refund / chargeback / adjustment / review-flag API returns has a label in all three catalogs. */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

const chargebackStatuses = [...new Set(CHARGEBACK_TRANSITIONS.flat())];
const errorCodes = [
  ...["idempotency_key_required", "idempotency_key_reused", "currency_mismatch", "payment_not_received", "exceeds_payment", "invalid_transition"].flatMap((code) => [
    `refund.${code}`,
    `chargeback.${code}`,
  ]),
  ...["idempotency_key_required", "idempotency_key_reused", "currency_mismatch", "outcome_not_of_job", "invalid_transition"].map((code) => `adjustment.${code}`),
  ...["idempotency_key_required", "assignee_cannot_see", "invalid_transition"].map((code) => `review_flag.${code}`),
];

const expectedKeys = [
  ...["REQUESTED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CANCELLED"].map((status) => `FINANCE.REFUND.STATUS.${status}`),
  ...chargebackStatuses.map((status) => `FINANCE.CHARGEBACK.STATUS.${status}`),
  ...["PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CANCELLED"].map((status) => `FINANCE.ADJUSTMENT.STATUS.${status}`),
  ...["CREDIT", "DEBIT"].map((direction) => `FINANCE.ADJUSTMENT.DIRECTION.${direction}`),
  ...[...ADJUSTMENT_REASON_CODES, CHARGEBACK_WRITE_OFF_REASON_CODE].map((code) => `FINANCE.ADJUSTMENT.REASON.${code.toUpperCase()}`),
  ...["OPEN", "ASSIGNED", "RESOLVED"].map((status) => `FINANCE.REVIEW_FLAG.STATUS.${status}`),
  ...Object.values(REVIEW_FLAG_REASONS).map((code) => `FINANCE.REVIEW_FLAG.REASON.${code.toUpperCase()}`),
  ...["unknown_payment", "missing_chargeback"].map((code) => `FINANCE.INTAKE.REJECTION.${code.toUpperCase()}`),
  ...errorCodes.map((code) => `FINANCE.ERROR.${code.toUpperCase()}`),
];

describe("finance correction catalog keys", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has every label the refund / chargeback / adjustment / review-flag API can return`, () => {
      expect(expectedKeys.filter((key) => typeof catalog[key] !== "string" || (catalog[key] as string).length === 0)).toEqual([]);
    });
  }
});
