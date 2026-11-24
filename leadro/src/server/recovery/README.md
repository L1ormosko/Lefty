# recovery

The Lead Recovery Engine (§9.3 - 9.7, §15 safety): rules that turn a not-converted visit into a recovery case, and the cases that
people work until the lead is recovered or closed. Routes: `/api/v1/lead-recovery/**` (`docs/API_REFERENCE.md` "Lead recovery").
Pure parts: `src/lib/recovery-rules.ts` (conditions, actions, high-impact, cooldown, presence) and `src/lib/recovery-lifecycle.ts`
(the §9.5 status machine). Decisions: `docs/DECISIONS.md` "Phase 3 Task 6".

Public API (`index.ts`):
- Rules: `createRule`, `updateRule` (DRAFT only), `newRuleVersion`, `submitRule`, `activateRule` (the approval for a high-impact rule),
  `deactivateRule` (also rejects a pending rule), `getRule`, `listRules`, `dryRunRule`.
- Engine: `handleOutcomeRecorded` (the subscriber), `registerRecoveryEngine()` (idempotent; subscribes through
  `onJobOutcomeRecorded("lead-recovery-engine", ...)`).
- Cases: `listCases`, `getCase`, `assignCase`, `changeCaseStatus`, `updateCase`, `recordAttempt`, `recoverCase`, `refreshPresence`,
  `recoverySummary`.
- Wiring: `registerRecoveryFollowUpTarget()` (follow-ups about a case), `registerRecoveryNotificationTarget()`, `caseResourceRefById` /
  `ruleResourceRefById` (route resolvers). Importing the module registers all three; `src/server/notification-targets.ts` (loaded by
  `instrumentation.ts`) calls them at server start so the engine is subscribed no matter which route runs first.

Invariants:
1. **The engine never throws and is fast.** It runs INSIDE the transaction that records the visit outcome. The whole handler and each rule
   run in a SAVEPOINT; a failure rolls back to it, is logged, and leaves a `RecoveryRuleRun` with `skippedReason = "error"`. The outcome
   always commits.
2. **No discounts, ever (§9.6).** The action vocabulary is closed (`create_case`, `set_priority`, `notify`, `create_follow_up`, `recommend`),
   every object is strict, and any key or value that mentions a discount is refused at authoring and dry-run. A stored rule that no
   longer validates is skipped, not run.
3. **Rules are versioned and immutable once they leave DRAFT** (database trigger). Editing = `newRuleVersion`; activating the new version
   supersedes the old one in the same transaction. Cases record `(ruleId, ruleVersion)`.
4. **High impact needs a second person.** `highImpact` is derived from the actions (`isHighImpact`); activating such a rule needs
   `recovery.approve` from someone other than the author (service check and database CHECK).
5. **Loop safety.** `(tenant, rule, outcome)` is unique in `RecoveryRuleRun` (re-running never fires twice); the cooldown is per rule key and
   customer; actions create no outcomes, so a case cannot trigger itself.
6. **Presence is a status, never a position (§26.5).** Derived from the technician's latest VALID location (`latestValidLocation`: fresh and
   accurate by the tenant's settings) and the site's coordinates; otherwise UNKNOWN with a machine reason. Only the status, accuracy, age and
   reason leave the module; the evidence event id and the distance are stored but never returned.
7. **Confirmed and estimated revenue never merge (§9.7).** `estimatedValueMinor` is a guess; `recoveredAmountMinor` / `collectedAmountMinor`
   are facts stored with `recoveredAt` by `recoverCase`. The summary reports them as separate figures per currency.
8. Every case status change locks the row, goes through the machine and writes a `RecoveryCaseStatusHistory` row in the same transaction.
   Audit values hold ids, codes and amounts only: no notes, no coordinates, no names.
9. Scope: cases follow `LeadRecoveryCase.orgUnitId` (ORG_UNIT / LEGAL_ENTITY; ASSIGNED / OWN = the assigned recovery employee); rules follow
   `RecoveryRule.orgUnitId` (a tenant-wide rule needs a TENANT scope). A denial for one record is a 404.
