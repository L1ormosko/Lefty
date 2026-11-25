# reconciliation

Reconciliation of expected (billed) against recorded (net collected) money, and the exceptions a person must look at (spec 5.7,
13.3, 25.4). Routes: `/api/v1/finance/reconciliation/**` (`docs/API_REFERENCE.md` "Finance: reconciliation"). Pure rules:
`src/lib/reconciliation-rules.ts`. Reads money only through the ledger's tables; never posts or changes money.

Public API (`index.ts`):
- **`startReconciliationRun`** (`finance_reconciliation.create`; TENANT or that LEGAL_ENTITY scope, tenant-wide = TENANT): one run per
  period / legal entity (or tenant) / currency, RUNNING (committed) -> COMPLETED with `jobsExamined`, `exceptionCount`, `expectedMinor`,
  `recordedMinor`, or FAILED `internal_error`; a RUNNING run older than `ABANDONED_AFTER_MS` is closed FAILED `abandoned` by the next run.
- Detection (`detect.ts`): UNPAID / PARTIAL_PAYMENT / OVERPAYMENT per job, FAILED_PAYMENT, DUPLICATE_EXTERNAL_EVENT,
  UNMATCHED_PROVIDER_EVENT, OUTCOME_LEDGER_MISMATCH, REFUND_WITHOUT_PAYMENT, OTHER `finance_confirmation_pending`.
- Reads (`finance_reconciliation.view`): `listReconciliationRuns`, `getReconciliationRun`, `listReconciliationExceptions`,
  `getReconciliationException`, `getReconciliationSummary`.
- Workflow: `assignReconciliationException` / `unassignReconciliationException` (`.assign`; the assignee must hold `.edit` over it),
  `resolveReconciliationException` (`.edit`, reason required, resolver = caller).
- `exceptionResourceRef`, `runResourceRef` for route resolvers.

Invariants:
- Idempotent re-runs: findings are matched to recorded exceptions by fingerprint (kind, code, currency, referenced records, not amounts);
  an unresolved one is never duplicated, a resolution with the same amounts stands. Runs of a tenant hold one advisory lock.
- What was found is frozen (DB trigger); exceptions and runs are never deleted; status machine OPEN <-> ASSIGNED -> RESOLVED (DB trigger).
- Scope: exceptions by their detection unit (none = TENANT only), runs by legal entity (TENANT / LEGAL_ENTITY only); out of scope = 404.
- Outcome money in an exception needs the `job_outcomes` `financial` set (else `moneyRedacted`). Ids, money and codes only in responses.
- Refunds (Task 5's tables) are read straight from the schema; this module does not depend on the adjustments module.
- Finance gains nothing operational: running or resolving never changes a job, a payment or the ledger.
