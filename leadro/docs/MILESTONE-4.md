# Milestone 4 report: Phase 4 (financial core), BACKEND ONLY

Format follows spec §28.7. This is a working backend prototype. **It is not production-ready and makes no security-review,
legal-compliance, accounting or readiness claim.** No screen, mobile app or payment provider exists for any feature below.

> **Compensation/commission formulas BLOCKED pending an approved compensation specification (§28.4).**
>
> Phase 4 builds everything AROUND compensation and nothing OF it: there are no commission, bonus, hourly, team or manager-incentive
> rules, no compensation policies, calculations or employee statements, no payroll tables and no wage deductions (spec 11.2, 11.3,
> 11.5, 11.6, 11.7, 11.9, Part 12). Spec 28.4 forbids inventing commission formulas without an approved detailed compensation
> specification, and none has been provided. What exists is what such a specification will need as inputs: charged and collected
> revenue in an append-only ledger, refunds / chargebacks / adjustments as explicit events, direct material cost per job from
> versioned costs, a generic approval engine with dual approval and separation of duties, and finance review flags wherever a money
> change could affect someone's pay ("a person decides", spec 11.7). **Next step for the owner: approve a compensation specification
> (bases, components, rounding, effective dating, statement and dispute workflow); the compensation module is built after that.**

## 1. Implemented features (by module, `src/server/<module>`)

- `approvals` (§21.3, §11.5): one generic engine. Versioned policies per subject type, currency and amount band (content frozen,
  `version + 1` on change, one active per code); requests snapshot the policy; single or dual approval; separation of duties (the
  requester and named editors / submitters never decide: service check + database trigger; one decision per person; the request row
  lock serializes concurrent approvers); expiry (a sweep function, no scheduler); cancel; subject callbacks through
  `registerApprovalSubject`; approver queue, own requests, oversight list; notifications without params. Subjects in use:
  MATERIAL_COST_CHANGE, REFUND, ADJUSTMENT, CHARGEBACK_WRITE_OFF (HIGH_VALUE_DISCOUNT exists in the enum, no discount record yet).
- `ledger` (§11.1, §11.8): the append-only ledger (DB triggers reject UPDATE / DELETE / TRUNCATE); ONE posting path and ONE reversal
  path, idempotent by deterministic keys (`INSERT ... ON CONFLICT DO NOTHING` + identity check); sign by type, source + reference, job
  currency, actor user XOR `system:<name>`, unit / legal-entity snapshot; derived balances and payment status per job, customer and legal
  entity (never stored); charge reversal; ledger correction domain event (review fix).
- `payments`: manual payments (required `Idempotency-Key`), status changes (receive / fail / void with reversal), **finance-confirmed
  revenue** from visit outcomes (confirmation queue, CHARGE and collection with `expectedAmountMinor`), the `PaymentProvider` port with an
  EMPTY registry ("not configured"), and the authenticated, store-first, validate-before-write provider intake (duplicate webhooks never
  double-post, §26.4).
- `materials` (§11.4): catalog, versioned costs (proposed through the approval engine, effective on their date, never overlapping, frozen
  once approved), job material costing as a frozen snapshot of the version in force at usage time (half-even per line), direct material
  cost per job, MATERIAL_COST ledger entries.
- `finance-adjustments` (§11.7, §25.4): refunds against received payments (approval per policy, money posted on payout), adjustments
  (signed, approval on the absolute amount, posted on approval), chargebacks (manual and provider intake, dispute, won = reversal, lost,
  write-off through approval as a system adjustment), over-return guard under the payment row lock, finance review flags (job reopened
  after posting, outcome corrected after posting, refund paid out, chargeback opened, material cost in another currency, charge reversed,
  received payment voided, manual) with assign / resolve.
- `reconciliation` (§5.7, §25.4): runs per period / legal entity / currency (expected = billed vs recorded = net collected per job,
  stored totals), exceptions (unpaid, partial, overpayment, failed payment, duplicate / unmatched provider event, outcome / ledger mismatch,
  refund without payment, finance confirmation pending), idempotent re-runs by fingerprint, exception workflow, summaries.
- Schema / catalog (Task 1): `Int` money columns migrated to `BigInt` (the 32-bit cap from Milestone 2+3 is gone), 14 new tenant tables
  with FORCE RLS, permission modules `materials`, `finance_ledger`, `finance_payments`, `finance_refunds`, `finance_chargebacks`,
  `finance_adjustments`, `finance_reconciliation`, `approvals`, the `materials.cost_fields` sensitive set, templates (Finance Director: full
  finance, no operational permission, §26.3), demo seed (materials, default approval policies).

## 2. Changed files

`git diff --stat 25d15a0..HEAD -- leadro/`: about 225 files. New modules `approvals`, `ledger`, `payments`, `materials`,
`finance-adjustments`, `reconciliation` (each with a README); 61 new route files (45 under `/api/v1/finance`, 8 under
`/api/v1/materials`, 8 under `/api/v1/approvals`; 222 route files in total); pure rules in `src/lib` (`money`, `approval-rules`,
`ledger-balances`, `material-cost-rules`, `finance-correction-rules`, `reconciliation-rules`); small hooks in `jobs` (status-change
event), `job-outcomes` (correction event), `core` (`rawBody` for the intake); catalogs in en-US / es-US / he-IL; 31 new test files.
Docs: `API_REFERENCE`, `ERD`, `PERMISSIONS`, `ARCHITECTURE`, `DECISIONS`, `reviews/phase4-review.md`, this report.

## 3. Database changes (migrations after Milestone 2+3, in order)

1. `20261124100000_phase4_financial_core`: Material, MaterialCostVersion, LedgerEntry, Payment, Refund, Chargeback, Adjustment,
   ApprovalPolicy, ApprovalRequest, ApprovalDecision, ReconciliationRun, ReconciliationException, PaymentIntakeEvent; JobMaterialUsage cost
   snapshot columns; Int -> BigInt money; RLS DO-block; append-only, no-delete, frozen-column and status-machine triggers; the reversal
   guard; the GiST no-overlap constraint on approved cost versions (`btree_gist`); the separation-of-duties decision guard.
2. `20261125100000_phase4_review_flags`: FinanceReviewFlag (+ RLS, checks, triggers) and the refund / outcome / unit references of
   reconciliation exceptions.

80 models in total (66 at Milestone 2+3), FORCE RLS on every tenant-owned table (`tests/db/rls.test.ts`). **No migration was added by the
review fixes.**

## 4. API changes (all under `/api/v1`, reference in `API_REFERENCE.md`)

New groups: `approvals` (queue, mine, list, get, decide, cancel, policies, deactivate), `materials` (catalog, archive, cost versions,
withdraw, usage / job costing, job material cost), `finance` (ledger entries, reverse, job / customer / legal-entity balances, job
balances, payments and their status changes, charges to confirm, outcome charge / collection, payment providers, provider intake, intake
log, refunds, adjustments, chargebacks, review flags, reconciliation runs / exceptions / summary). Review changes: `POST
/finance/payments/{id}/void` answers `409 payment.money_returned` when a POSTED refund or a not-won chargeback holds the payment; charge
reversals and voids of received payments raise review flags; concurrent intake events about one provider payment are DUPLICATE; cost-change
approval amounts are redacted for approvers without the `cost` set.

## 5. Tests (final run, `leadro/`, real PostgreSQL 16, after the last commit)

| Check | Result |
|---|---|
| `npm test` (Vitest) | **TEST_RESULT** |
| `npm run typecheck` | TYPECHECK_RESULT |
| `npm run lint` | LINT_RESULT |
| `npm run i18n:check` | I18N_RESULT |
| `npm run build` | BUILD_RESULT |
| `npm run test:e2e` | not run for this milestone (no Phase 4 screen exists; the 9 Phase 1 specs are unchanged) |

Error log lines printed by negative tests (trigger refusals, a provider that throws, a failing subject handler) are expected. Phase 4 adds
31 test files: unit tests of every pure rule module, integration tests of every service against the real database (tenant isolation,
scope, field sets, separation of duties, concurrency bursts, duplicate webhooks, append-only and frozen columns at the database), route
tests, catalog-key coverage per locale and the seed. The review added `tests/finance-adjustments/phase4-hardening.test.ts` and regression
cases in `tests/finance/intake.test.ts` and `tests/materials/materials.test.ts`. **There is no end-to-end chain test** (outcome ->
confirmation -> payment -> refund -> reconciliation run) beyond the per-link integration tests.

## 6. Known limitations and gaps (do not assume these exist)

- **Compensation / commission / statements: not built, blocked on §28.4** (top of this report).
- **No payment provider is configured.** The registry is empty; every intake call answers `409 payment_provider.not_configured` and
  writes nothing. A real provider needs per-tenant secrets in an encrypted connection table (a later migration); tests use their own
  HMAC provider. Refund payouts are recorded by hand (`Refund.providerRef` holds the reference).
- **No scheduler or worker**: approval expiry (`expireDueApprovalRequestsForAllTenants`) and reconciliation runs are functions / synchronous
  endpoints nobody calls on a schedule; runs are bounded to 366 days and 120 s.
- **UI deferred**: no finance, materials or approvals screen.
- Not built: exports (`finance_ledger.export`, `finance_reconciliation.export`, `materials.export` have no endpoint), "Other Direct
  Cost" and discount records (HIGH_VALUE_DISCOUNT has no subject module), customer-only adjustments, matching an UNMATCHED intake event by
  hand, provider payment-failed / refund events, notifications for review flags and new confirmation-queue items, a MATERIAL_COST
  correction path (a costed line is frozen), gross profit and every analytics figure (§13).
- Reconciliation balances are "as the ledger knows them at run time", not "as of period end" (ruling below); stale exceptions are not
  auto-closed.
- Translations of the new FINANCE.* / MATERIAL.* / APPROVAL.* keys in es-US and he-IL are machine-quality and need human review.
- The accounting treatment (spec 11.1) is not reviewed by a qualified finance professional; balances are operational figures, not
  financial statements. Gross profit is not computed and must never be shown as net profit.
- Inherited: in-memory rate limiting, trigger-only audit immutability, MFA trust-on-first-use, provisional role templates (MILESTONE-1 §6,
  MILESTONE-2-3 §6).

## 7. Security implications

- Money is BigInt end to end, decimal strings in JSON, `MAX_MONEY_MINOR` at the boundary; one currency per job enforced at posting.
- The ledger is append-only at the database; every correction is a REVERSAL or an explicit record. Every posting key is deterministic,
  so retries, double clicks, concurrent requests and duplicate webhooks post once (tested with bursts).
- Separation of duties is enforced twice (service + trigger). Finance permissions reach jobs through their unit only (OWN / ASSIGNED
  scopes never match finance records); outcome money stays behind the `job_outcomes` `financial` set; material costs behind the `cost`
  set (now also inside approval requests). Finance Director holds no operational permission (§26.3, tested).
- The provider intake verifies the signature before using any claimed id, stores before processing, validates before writing, and never
  stores the raw payload. Known limitation: with a provider configured, anyone knowing a tenant slug can make it write one REJECTED row per
  distinct forged body (rate limiting is Phase 8).
- Single-person corrections (charge reversal, void of a received payment) need no approval; each now raises a finance review flag.
- No security review, penetration test, accounting or legal review (spec 22.3: payment processing) has been done.

## 8. Review results (`docs/reviews/phase4-review.md`)

Phase 4 ran in economy mode (no per-task reviewer), so a whole-phase review was done at the end. Each suspected defect was reproduced
with a failing test first.

| Id | Severity | Finding | Status |
|---|---|---|---|
| P4-R1 | Important | Voiding a payment with a POSTED refund / not-won chargeback counted the money as gone twice; the void took no payment lock | Fixed |
| P4-R2 | Important | Charge reversal and void of a received payment: one person, no approval, nobody told | Fixed (review flag); approval = owner decision |
| P4-R3 | Minor | Concurrent intake events about one provider payment were all ACCEPTED (ledger was already safe) | Fixed |
| P4-R4 | Minor | An `approvals.configure` holder can deactivate the policy covering their own request | Deferred (owner) |
| P4-R5 | Minor | Cost-change approval details showed unit costs to approvers without the `cost` set | Fixed |
| P4-R6 | Minor | Charges-to-confirm filters the outcome `financial` set after paging (short pages, nothing leaked) | Deferred |
| P4-R7 | Minor | Unit managers may record the payout of an approved refund | Deferred (owner) |

No Critical finding. RLS on all new tables, append-only enforcement, idempotency, SoD, BigInt money, currency rules, intake ordering,
authorization on every route and service, audits and notification contents were checked and found sound.

## 9. Decisions for the owner's improvement round

Rulings the manager took on the owner's behalf during Phase 4 (the owner asked to finish without waiting and to review them at the
end). None was reversed by the review.

1. **Revenue is finance-confirmed, not automatic** from the technician's outcome (§11 human oversight). Cost if wrong: an outcome hook
   calling the same two functions with a system actor.
2. **Economy mode**: no per-task reviewer, manager verification per task plus one whole-phase review (this one).
3. **Approvals**: an amount in a currency no policy covers is refused (400), never waved through; amounts are hidden from
   `approvals.manage`-only overseers; a request's scope is fixed at creation; a rejection needs a comment.
4. **Materials**: extended cost rounded **half-even per usage line** (owner review; decide before production data is costed, snapshots
   are frozen); a new cost version must start after the current one and after every usage costed with it; costing is an explicit endpoint
   needing `jobs.view` + the `cost` set; the COO maintains the catalog without seeing costs; costing posts MATERIAL_COST ledger entries.
5. **Schema**: a `FinanceReviewFlag` table; no provider-settings table yet (later migration with encrypted secrets); no "Other Direct
   Cost" or discount record.
6. **Corrections**: money moves on the real event (refund at payout, chargeback at opening, adjustment at approval); a chargeback
   write-off is a system adjustment of minus its amount; the seeded policies make every refund and adjustment need an approver.
7. **Reconciliation**: balances as of run time (not period end); UNPAID is an exception kind; stale exceptions are not auto-closed;
   chargebacks are not an exception source; runs are synchronous.
8. **Translations** of the new keys need human review.
9. **From this review**: should a charge reversal / void of a received payment require an approval (P4-R2; today a review flag)? Should
   policy changes be approved, or `approvals.configure` kept from people who request money movements (P4-R4)? May unit managers record
   refund payouts (P4-R7)?

## 10. Remaining tasks

The compensation specification and module (blocked, §28.4); a real payment provider with encrypted per-tenant secrets; a scheduler /
worker (approval expiry, reconciliation runs, notification delivery, sweeps); finance / materials / approvals UI; exports; notifications
for review flags; the deferred review items (P4-R4, R6, R7) and the owner's decisions in section 9; an end-to-end financial chain test;
accounting and legal review; Phase 8 hardening (rate limiting on the intake, shared rate-limit store, DDL vs runtime role).
