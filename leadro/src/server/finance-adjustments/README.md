# finance-adjustments

Refunds, chargebacks, adjustments and finance review flags (spec 11.1, 11.7, 11.8, 21.3, 25.4). Routes:
`/api/v1/finance/(refunds|chargebacks|adjustments|review-flags)/**` (`docs/API_REFERENCE.md` "Finance: refunds, chargebacks, adjustments,
review flags"). Pure rules: `src/lib/finance-correction-rules.ts`. Decisions: `docs/DECISIONS.md` "Phase 4 Task 5". Money moves only through
`src/server/ledger`; approvals only through `src/server/approvals`.

Public API (`index.ts`):
- Refunds (`refunds.ts`): `requestRefund` (against one RECEIVED payment, partial allowed), `completeRefund` (paid out: REFUND entry),
  `cancelRefund`, `listRefunds`, `getRefund`. Subject `REFUND`.
- Adjustments (`adjustments.ts`): `requestAdjustment` (signed credit / debit on a job with a reason code), `cancelAdjustment`, reads. Subject
  `ADJUSTMENT` (policy band on the absolute amount); approved = posted (ADJUSTMENT entry) in the same transaction.
- Chargebacks (`chargebacks.ts`, `chargeback-intake.ts`): `recordChargeback` (manual) and the intake handler `chargeback.opened` (CHARGEBACK
  entry), `disputeChargeback`, `markChargebackWon` (REVERSAL of the CHARGEBACK entry), `markChargebackLost`, `requestChargebackWriteOff`
  (subject `CHARGEBACK_WRITE_OFF`; written off = a posted system adjustment of minus the amount).
- Review flags (`review-flags.ts`): `raiseFinanceReviewFlagInTx` (for other modules, inside their transaction), `raiseManualFlag`,
  `assignReviewFlag`, `unassignReviewFlag`, `resolveReviewFlag`, reads.
- Wiring (`wiring.ts`): `registerFinanceAdjustments()` (module load and `src/server/notification-targets.ts`): the three approval subjects,
  the intake handler, and the reactions `onJobStatusChanged` (job reopened after posting), `onJobOutcomeCorrected` (outcome money
  corrected after posting) and `onLedgerCorrection` (a CHARGE reversed or a RECEIVED payment voided by one person, with no approval
  behind it: flags `ledger.charge_reversed` / `payment.voided_after_receipt`, Phase 4 review P4-R2).

Invariants:
1. **Explicit events, never edits** (11.7, 11.8). Records are never deleted; amount, currency, job, payment, reason and requester are frozen
   (DB triggers); status machines are the database's. Every posting has a deterministic key (`keys.ts`): retries, double clicks, concurrent
   requests and duplicate webhooks post once.
2. **A payment is never over-returned.** Refunds holding a payment plus chargebacks not won never exceed it (manual paths), checked under the
   payment row lock. A provider chargeback is never refused for its amount; the review flag says when it exceeds what was left.
3. **Separation of duties** comes from the approval engine: the requester never decides; a write-off also excludes whoever recorded the
   chargeback. Without an active policy for the amount the change applies at once (`approvalRequestId = null`).
4. **Corrections are reproducible.** A won chargeback is a REVERSAL; a mistaken adjustment is corrected by a counter-adjustment; a reopened
   job or a corrected outcome never touches posted entries: it raises a review flag and finance records an adjustment.
5. **No wage deductions, no commission effects** (11.7, 28.4). Nothing here references employees' pay; refunds paid out and chargebacks
   opened raise review flags so a person decides.
6. **Flags are idempotent per triggering event** (key per status-history row, job event, refund, chargeback, usage line, reversal entry, or the client's
   `Idempotency-Key`); what was flagged is frozen, only assignment and resolution move (OPEN <-> ASSIGNED -> RESOLVED with a reason).
7. **Access**: finance permissions over the job's current unit (never OWN / ASSIGNED); flags by their own unit with the
   `finance_reconciliation.*` keys. Responses carry ids, money, codes and the people's own reason / note text, never operational data.
