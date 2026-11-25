# payments

Payment records, revenue confirmed from visit outcomes, and the payment provider boundary (spec 11.1, 11.8, 18.3, 26.4).
Routes: `/api/v1/finance/{payments,charges-to-confirm,outcomes,intake,intake-events,payment-providers}/**` (`docs/API_REFERENCE.md`
"Finance: ledger, payments, revenue confirmation, provider intake"). Money moves only through `src/server/ledger`.

Public API (`index.ts`):
- `recordManualPayment` (`finance_payments.create` over the job): cash / check / card terminal / bank transfer, reference required for
  CHECK, CARD, BANK_TRANSFER; the client's REQUIRED `Idempotency-Key` becomes `Payment.idempotencyKey` (per user), so a duplicate submit is
  one payment. RECEIVED posts the PAYMENT entry at once; PENDING waits for `markPaymentReceived`.
- `markPaymentReceived`, `markPaymentFailed`, `voidPayment` (`finance_payments.edit`): conditional status updates (the DB trigger owns the
  machine), replay when the status is already the target; voiding a RECEIVED payment REVERSES its entry.
- `listPayments`, `getPayment`, `paymentResourceRef` (`finance_payments.view`; a payment's scope follows its job's current unit).
- **Revenue from outcomes** (`outcome-revenue.ts`): finance-confirmed, never automatic. `listChargesToConfirm` (queue), `confirmOutcomeCharge`
  (CHARGE, key `outcome:<id>:charge:<n>`), `confirmOutcomeCollection` (MANUAL payment linked to the outcome, key
  `outcome:<id>:collection:<n>`). Both need `finance_payments.create` AND the outcome `financial` set, and an `expectedAmountMinor` equal
  to the outcome's current amount.
- **Provider boundary** (`provider.ts`): `PaymentProvider` (`verifyEvent` with the provider's per-tenant secret, `parseEvent`), registry
  `registerPaymentProvider` / `getPaymentProvider` on `globalThis`, EMPTY by default ("not configured"), `hmacSha256Matches` helper.
- **Intake** (`intake.ts`): `receiveProviderEvent`: not configured / unknown tenant = 409 before any write; bad signature = 401 + REJECTED row
  under `unverified:<hash>`; verified event stored first (unique per tenant / provider / externalId), then processed under a row lock:
  validate (event type, job, currency, provider reference) before creating a PROVIDER payment + PAYMENT entry (`system:provider-intake`).
  `listIntakeEvents` (TENANT scope), `listPaymentProviders`.

Invariants:
- A payment record is never deleted; amount, currency, method, origin and provider fields are frozen (DB triggers).
- Every posting key is deterministic: retries, double clicks, concurrent requests and duplicate webhooks post once (spec 26.4).
- The intake never stores the raw payload (SHA-256 + normalized fields only) and never trusts a body before its signature verified.
- Finance permissions grant nothing operational (spec 26.3); responses carry ids and money only.
