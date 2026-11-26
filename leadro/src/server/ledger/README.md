# ledger

The append-only money ledger (spec 11.1, 11.8) and every balance derived from it. Routes: `/api/v1/finance/ledger/**`,
`/api/v1/finance/{jobs,customers,legal-entities}/{id}/balance`, `/api/v1/finance/job-balances` (`docs/API_REFERENCE.md`
"Finance: ledger, payments, provider intake"). Pure rules: `src/lib/ledger-balances.ts`.

Public API (`index.ts`):
- **`postLedgerEntryInTx(tx, input)`**: the ONE posting function (every module that moves money calls it inside its own
  transaction, after its own permission check). Sign by type, source + its reference, job currency, actor user XOR
  `system:<name>`, `orgUnitId` / `legalEntityId` / `customerId` copied from the job. Idempotent by a deterministic
  `idempotencyKey` (`ledgerKeys`, `paymentKeys`): `INSERT ... ON CONFLICT DO NOTHING`, then the row under the key is
  returned with `replayed`; the same key for a different entry is `409 ledger.idempotency_key_reused`.
- **`reverseLedgerEntryInTx(tx, input)`**: the exact negative of one entry (same job / customer / currency / references /
  snapshot), key `reversal:<entryId>`; a reversal is never reversed; a second reversal is `409 ledger.already_reversed`.
- `reverseCharge` (`finance_payments.edit` over the job): the API correction of a posted CHARGE. Other entry types are
  corrected by their own records' flows (void a payment; Task 5 refunds / chargebacks / adjustments).
- **`onLedgerCorrection(name, handler)` / `publishLedgerCorrection(tx, event)`**: the in-transaction domain event of a single-person
  correction that takes money out of the books (CHARGE reversed, RECEIVED payment voided; payments publishes through it). No
  approval stands behind those, so finance-adjustments subscribes and raises a finance review flag (Phase 4 review P4-R2).
- Reads (`finance_ledger.view`): `listLedgerEntries`, `getLedgerEntry`, `getJobBalance`, `getCustomerBalance`,
  `getLegalEntityBalance`, `listJobBalances`; `jobBalanceInTx` / `ledgerAmountsInTx` for other finance modules.
- `loadFinanceJob`, `financeJobRef` (job's unit only: OWN / ASSIGNED scopes never reach finance), scope columns.

Invariants:
- Append-only (DB triggers reject UPDATE / DELETE / TRUNCATE); balances are never stored, always summed at read time.
- A REVERSAL counts under the type it reverses, so corrections land in the bucket they correct.
- Responses carry ids, money and finance codes only: no job titles, addresses or customer names (finance roles see a
  job's `financial` set only, spec 22.2), so a finance read never widens operational visibility.
- Amounts are `bigint` in code and decimal strings in JSON.
