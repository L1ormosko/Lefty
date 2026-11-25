# LEADRO — Implementation Plan: Phase 4 (Financial Core) — backend, formula-free

Spec: `leadro/docs/SPEC.md` (binding), especially Part 11, §21.3, §25.4, §26.4, §28.4.
Scope decision: UI deferred (owner). **Commission/compensation formulas are NOT implemented** —
§28.4 forbids inventing them without an approved compensation specification. This phase builds
everything around them: materials with versioned costs, the append-only ledger, payments, refunds,
chargebacks, adjustments, the generic approval engine, and reconciliation. Compensation policies,
calculations and employee statements wait for the owner's spec (recorded as blocked).

## Global Constraints (Phase 1–3 constraints still bind)

- Money: integer minor units + ISO currency. New money columns are `BigInt` (Phase 2/3 Int columns
  are migrated to BigInt in Task 1 — §11.8 and the 32-bit cap disclosed in Milestone 2+3).
  Never floats; arithmetic in BigInt only; rounding never happens in this phase (no formulas).
- Ledger (§11.8): append-only from the application's perspective (DB trigger rejects UPDATE/DELETE);
  corrections only by reversal/adjustment entries linked to the original; every entry carries source
  (job/outcome/payment/refund/adjustment), actor or system, idempotency key, occurredAt + recordedAt.
  Balances are derived (sum of entries), never stored as the source of truth.
- Historical integrity (§11.4, §25.4): a material cost change never rewrites past job costs — job
  material usage snapshots the cost version used.
- Approvals (§21.3, §11.5): one generic engine; configurable policies per subject type (material cost
  change, adjustment, refund, chargeback write-off, high-value discount); single or dual approval;
  separation of duties (requester/editor/submitter never approves); every decision audited.
- Financial data is sensitive (§22.2): finance permissions + financial field sets; Finance does not
  gain operational permissions (§26.3); no payroll claims (§11.9); no automatic wage deductions (§11.7).
- No fake providers: payment processing behind a `PaymentProvider` interface ("not configured");
  external payment events ingested only through an authenticated, idempotent intake that validates
  before touching core records (§18.3); duplicate webhooks never double-post (§26.4).
- Same module/pipeline/RLS/audit/i18n/doc rules as before; only Task 1 adds migrations.

## Task 1: Phase 4 schema + catalog
Material (code, name, unit, supplier?, active), MaterialCostVersion (material, cost minor + currency,
effectiveFrom/To, approval ref, createdBy; immutable once approved), link JobMaterialUsage → material +
cost version snapshot (unit cost, extended cost), LedgerEntry (append-only; type: CHARGE, PAYMENT,
REFUND, CHARGEBACK, ADJUSTMENT, REVERSAL, MATERIAL_COST; amount signed BigInt; currency; job/customer/
outcome/payment refs; reversesEntryId; idempotencyKey unique; source; occurredAt/recordedAt),
Payment (job, method, status, amount, provider ref?, received/failed), Refund, Chargeback, Adjustment
(reason, amount, status, approval ref), ApprovalPolicy (subjectType, thresholds, requiredApprovals 1|2,
approver permission, active, version), ApprovalRequest + ApprovalDecision (append-only), Reconciliation
run + ReconciliationException, PaymentIntakeEvent (external webhook log: provider, externalId unique,
payload hash, validation result). Int→BigInt migration for existing money columns. Permission catalog:
materials.*, finance.* (ledger view/export, payments, refunds, adjustments, reconciliation),
approvals.* ; templates per §4.4/§4.5 (Finance Director full finance, no dispatch; Owner; managers
limited/scoped views). RLS + tests.

## Task 2: Materials catalog + versioned costs (§11.4)
CRUD materials; propose cost version → approval engine (if policy) → effective on date; history list;
job material usage costing (snapshot of the version effective at usage time; later changes never
rewrite); direct material cost per job query. APIs `/api/v1/materials/*`.

## Task 3: Approval engine (§21.3, §11.5)
Generic requests/decisions, policy resolution by subject + amount thresholds, dual approval, SoD,
expiry, cancel, callbacks per subject type via a registry (`registerApprovalSubject`), audit, queue
APIs `/api/v1/approvals/*`, notifications to approvers (scope-filtered).

## Task 4: Ledger + revenue + payments (§11.1, §11.8)
Ledger service (post entries idempotently, reverse, derived balances per job/customer); revenue
records from outcomes (charged amount → CHARGE entry; collected → PAYMENT entry) via the outcome hook
or explicit finance action — choose and document; manual payment recording (cash/check/card-terminal
with reference); payment status per job (unpaid/partial/paid/overpaid/refunded); PaymentProvider
interface + authenticated intake endpoint for provider events (validated, idempotent by externalId,
not configured by default). APIs `/api/v1/finance/*`.

## Task 5: Refunds, chargebacks, adjustments (§11.7, §25.4)
Explicit events with approval where policy requires; ledger postings + reversals; never delete/rewrite;
finance review flags; job reopened → adjustments, not edits; corrections reproducible.

## Task 6: Reconciliation (§5.7, §13.3 subset, §25.4)
Reconciliation runs per period/legal entity: expected (charged) vs recorded (payments) per job; exceptions
(partial, failed, duplicate external events, outcome/ledger mismatch, refunds without payment); exception
workflow (assign, resolve with reason); summaries. APIs.

## Task 7: Hardening + MILESTONE-4
Full verification, docs, `docs/MILESTONE-4.md` (§28.7) with "compensation blocked on spec" front and center.
