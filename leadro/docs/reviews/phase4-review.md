# Phase 4 whole-phase review (financial core)

Scope: `git diff 25d15a0..HEAD -- leadro/` (approvals, ledger, payments, materials, reconciliation, finance-adjustments, the
`/api/v1/finance/**`, `/api/v1/materials/**` and `/api/v1/approvals/**` routes, the two Phase 4 migrations, templates and seed).
Phase 4 ran in "economy mode" (no per-task reviewer), so this is the first independent review of the whole phase.
Manager rulings in the Phase 4 ledger (finance-confirmed revenue, half-even rounding, balances as of run time, and the others) are
not findings: they are listed for the owner's improvement round in `MILESTONE-4.md`.

Each suspected defect was reproduced with a failing test against the real test database before it was fixed. The
regression tests are `tests/finance-adjustments/phase4-hardening.test.ts` and the `P4-R3` case in `tests/finance/intake.test.ts`.

## Findings

| Id | Severity | Where | Status |
|---|---|---|---|
| P4-R1 | Important | `src/server/payments/status.ts:85` (`voidPayment`) | Fixed |
| P4-R2 | Important | `src/server/ledger/entries.ts:80` (`reverseCharge`), `src/server/payments/status.ts:85` (`voidPayment`) | Fixed (review flag; approval is an owner decision) |
| P4-R3 | Minor | `src/server/payments/intake.ts:233` (`processEvent`) | Fixed |
| P4-R4 | Minor | `src/server/approvals/policies.ts:59,125` | Deferred (owner decision) |
| P4-R5 | Minor | `src/server/approvals/access.ts:95` (`moneyVisibleTo`) | Deferred |
| P4-R6 | Minor | `src/server/payments/outcome-revenue.ts:123` | Deferred |
| P4-R7 | Minor | `src/server/finance-adjustments/refunds.ts:169` (`completeRefund`) | Deferred (owner decision) |

No Critical finding. Checked and found sound (with the evidence looked at): RLS + FORCE on all 14 new tables (fail-closed DO block,
`tests/db/rls.test.ts` lists them); append-only ledger and decisions (UPDATE/DELETE/TRUNCATE triggers, reversal guard trigger, one
reversal per entry); deterministic idempotency keys with `INSERT ... ON CONFLICT DO NOTHING` + identity comparison on every posting
path; separation of duties in the approval engine (service check + `approval_decision_guard` trigger, one decision per person by
unique index, request row lock serializing two approvers, policy snapshot frozen by trigger); BigInt money end to end with a
safe-integer / decimal-string API boundary and `MAX_MONEY_MINOR`; one currency per job enforced at posting; provider intake verifies
the signature before storing under the claimed id, stores before processing, and validates before writing any payment; route-level
`requirePermission` plus an in-transaction re-check on every finance, materials and approvals service; outcome money behind the
`job_outcomes` `financial` set in the confirmation queue, revenue confirmation and reconciliation; no Phase 4 template gives Finance
an operational permission (§26.3); audit events on every mutation; approval notifications carry no params.

## P4-R1 (Important): a payment whose money already went back out could be voided

**Scenario.** A cash payment of 100.00 is RECEIVED, a 30.00 refund is paid out (REFUND entry), then someone voids the payment
(`POST /finance/payments/{id}/void`). The void reversed the full PAYMENT entry and left the REFUND in place: collected 0, refunded
30.00, net collected **-30.00**, so the ledger said the business paid the customer 30.00 out of nothing. The same happened with an
open or lost chargeback (its CHARGEBACK entry stays, so the money left twice). `voidPayment` also did not lock the payment row,
so a refund payout and a void running at the same moment both succeeded even though `completeRefund` locks the row
(reproduced: both requests answered 200). DECISIONS.md Phase 4 Task 5 recorded this as a "known gap" for reconciliation to catch.

**Fix.** `voidPayment` locks the payment row (`SELECT ... FOR UPDATE`, the same lock refunds and chargebacks take) and refuses to
void a RECEIVED payment that has a POSTED refund or a chargeback that was not WON: `409 payment.money_returned`. Refunds that were
not paid out yet still do not block the void (`completeRefund` already refuses them afterwards, an existing tested path).
Regression: `tests/finance-adjustments/phase4-hardening.test.ts` "P4-R1" (posted refund, open chargeback, concurrent payout + void).

## P4-R2 (Important): one person could remove billed or collected money with no second person ever looking

**Scenario.** Reversing a CHARGE (`POST /finance/ledger/entries/{id}/reverse`) removes what the customer was billed; voiding a
RECEIVED payment removes money that was collected. Both need only `finance_payments.edit`, have no approval policy and no
separation of duties, while the equivalent negative ADJUSTMENT needs an approver by default (seeded `adjustment_standard` from 0).
Example: a Finance Director records 500.00 cash, then voids it "recorded by mistake": the books show nothing was collected and no
second person is told. Spec 21.3 (financial adjustments are approval subjects, nobody approves their own action) and 11.7 ("flag for
finance review").

**Fix (smallest change that keeps the manager's revenue ruling).** Both corrections now publish a ledger correction event inside
their transaction (`onLedgerCorrection` in the ledger module; the payments module publishes through it, so there is no import
cycle). The finance-adjustments module subscribes and raises a finance review flag (`ledger.charge_reversed` /
`payment.voided_after_receipt`, system actor `system:finance-review`, one flag per correction by a deterministic key), so another
finance person sees every such correction in the review-flag queue. Putting these corrections behind the approval engine (an
approval subject type, i.e. a schema change) is left to the owner (listed in MILESTONE-4.md). Voiding a PENDING payment moved no
money and raises nothing. Regression: `phase4-hardening.test.ts` "P4-R2".

## P4-R3 (Minor): concurrent events about one provider payment were all ACCEPTED

**Scenario.** Two (or more) webhook events with DIFFERENT event ids about the SAME provider payment arrive at once. Each passed
the "provider reference not seen" check before any payment existed; the payment insert is idempotent, so only one payment and one
PAYMENT entry were written (no double posting, §26.4 holds), but every event was marked ACCEPTED with the same `paymentId`
instead of one ACCEPTED and the rest DUPLICATE. The intake log then misstated what happened and reconciliation's
DUPLICATE_EXTERNAL_EVENT finding missed them. Reproduced with 6 concurrent events: 6 ACCEPTED.

**Fix.** `processEvent` uses the `replayed` flag of `createPaymentIdempotently`: when the payment already existed under the
provider key, the event is DUPLICATE `duplicate_provider_ref` with `duplicateOfId` = the accepting event, exactly like the
sequential case. Regression: `tests/finance/intake.test.ts` "P4-R3".

## Deferred (Minor)

- **P4-R4: policy configuration is not itself approved.** A holder of `approvals.configure` (the Finance Director template) can
  deactivate the policy that covers a refund or adjustment, then request and complete it alone. Policy changes are versioned and
  audited (`approval_policy.*`), but spec 21.3 also lists configuration changes as possible approval subjects. Owner decision:
  approval for policy changes, or keeping `approvals.configure` away from people who request money movements.
- **P4-R5: cost-change approval details show unit costs to any approver.** A MATERIAL_COST_CHANGE request's `details` carry old and
  new unit costs; an approver holding `materials.approve` without the `cost` field set would see them. No template has that
  combination (Finance has both), so this needs a custom role. Fix later: hide `details` for that subject without the cost set.
- **P4-R6: the charges-to-confirm queue filters the outcome `financial` set after paging.** A page can come back short (even empty)
  while more rows exist; the cursor still advances correctly, so nothing is hidden or leaked. Fix later: filter in SQL.
- **P4-R7: who records a refund payout.** `completeRefund` (posts the REFUND entry) needs `finance_refunds.create`, which the unit
  manager templates hold, so a unit manager can record the payout of an approved refund. The refund itself was approved by finance;
  whether the payout record must also be finance-only is an owner decision.
- **Splitting under a no-approval band.** A tenant that configures a gap ("refunds under 50.00 need no approval") lets one person
  make several small refunds. The seeded policies start at 0, so the default needs an approver for every refund and adjustment;
  documented, not a code defect.
