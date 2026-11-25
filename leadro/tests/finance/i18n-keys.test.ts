import { describe, expect, it } from "vitest";
import { JOB_PAYMENT_STATUSES, LEDGER_ENTRY_TYPES } from "@/lib/ledger-balances";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { PAYMENT_PROVIDER_NOT_CONFIGURED } from "@/server/payments";

/** Every language-neutral value the finance API returns has a label in all three catalogs (clients render by key). */
const catalogs: Record<string, Record<string, unknown>> = { "en-US": enUS.messages, "es-US": esUS.messages, "he-IL": heIL.messages };

/** `ledger.wrong_sign` -> `FINANCE.ERROR.LEDGER.WRONG_SIGN` (detail codes the finance services throw). */
const errorKey = (code: string) => `FINANCE.ERROR.${code.toUpperCase()}`;

const expectedKeys = [
  ...JOB_PAYMENT_STATUSES.map((status) => `FINANCE.PAYMENT_STATUS.${status}`),
  ...LEDGER_ENTRY_TYPES.map((type) => `FINANCE.LEDGER.TYPE.${type}`),
  ...["JOB", "OUTCOME", "PAYMENT", "REFUND", "CHARGEBACK", "ADJUSTMENT", "MATERIAL_USAGE", "REVERSAL"].map((source) => `FINANCE.LEDGER.SOURCE.${source}`),
  ...["PENDING", "RECEIVED", "FAILED", "VOIDED"].map((status) => `FINANCE.PAYMENT.STATUS.${status}`),
  ...["MANUAL", "PROVIDER"].map((origin) => `FINANCE.PAYMENT.ORIGIN.${origin}`),
  ...["NOT_REQUIRED", "PENDING", "POSTED", "MISMATCH"].map((state) => `FINANCE.REVENUE.STATE.${state}`),
  ...["RECEIVED", "ACCEPTED", "REJECTED", "DUPLICATE", "UNMATCHED"].map((status) => `FINANCE.INTAKE.STATUS.${status}`),
  ...["bad_signature", "malformed_event", "invalid_event_fields", "unsupported_event_type", "unknown_job", "currency_mismatch", "duplicate_provider_ref"].map(
    (code) => `FINANCE.INTAKE.REJECTION.${code.toUpperCase()}`,
  ),
  ...[
    "ledger.wrong_sign",
    "ledger.currency_mismatch",
    "ledger.idempotency_key_reused",
    "ledger.already_reversed",
    "ledger.reversal_not_reversible",
    "ledger.reverse_not_supported",
    "payment.idempotency_key_required",
    "payment.idempotency_key_reused",
    "payment.currency_mismatch",
    "payment.invalid_transition",
    "revenue.outcome_changed",
    "revenue.nothing_to_charge",
    "revenue.nothing_to_collect",
    "revenue.charge_already_posted",
    "revenue.collection_already_recorded",
    "revenue.method_required",
    "revenue.financial_set_required",
    "payment_intake.payload_mismatch",
  ].map(errorKey),
  "FINANCE.BALANCE.COVERAGE.TENANT",
  "FINANCE.BALANCE.COVERAGE.SCOPE",
  PAYMENT_PROVIDER_NOT_CONFIGURED === "payment_provider.not_configured" ? "FINANCE.PROVIDER.NOT_CONFIGURED" : "MISSING",
];

describe("finance catalog keys", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has every FINANCE.* label the API can return`, () => {
      expect(expectedKeys.filter((key) => typeof catalog[key] !== "string" || (catalog[key] as string).length === 0)).toEqual([]);
    });
  }
});
