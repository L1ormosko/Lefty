# Milestone 5 report: Phase 5 (workforce intelligence), BACKEND ONLY

Format follows spec §28.7. This is a working backend prototype. **It is not production-ready and makes no security-review,
legal-compliance (spec 22.3 "employee monitoring", "automated employment decisions"), HR or readiness claim.** No screen or mobile
app exists for any feature below, and no survey provider is connected.

> **Performance data is development data only (spec 10.3, default "Employee performance: development use", "Performance-based job
> exclusion: prohibited").** Nothing in Phase 5 can reduce work assignments, remove eligibility, change compensation, reduce
> commissions, suspend anyone or change employment status. This is structural: the modules that decide those things cannot import or
> read the Phase 5 modules or tables (architecture tests, section 7). **Compensation / commission formulas remain BLOCKED pending an
> approved compensation specification (§28.4)**; Phase 5 adds no compensation input.

## 1. Implemented features (by module, `src/server/<module>`)

- `training` (§10.1 Training, §5.8): course catalog (tenant reference data, archive, never delete; optionally grants a TRAINING
  certification); assignments (manual, or from an accepted recommendation) with due dates, start, cancel, derived overdue; completion
  records with evidence METADATA (no StorageProvider configured); HR verification / rejection / revocation (never one's own); a VERIFIED
  record of a course that grants a TRAINING certification creates / renews / restates the `EmployeeQualification` through the
  qualifications module (`training-grants.ts`), so the eligibility engine sees the legal credential; expiry fixed at recording;
  expiring / overdue queries; a notification sweep function (assigned, overdue, expiring, expired).
- `performance` (§10.2): a fixed catalog of 7 computable kinds over real data (REPEAT_VISIT_RATE, ON_TIME_ARRIVAL,
  DOCUMENTATION_COMPLETENESS, OUTCOME_CONVERSION, RECOVERY_CONVERSION, CUSTOMER_FEEDBACK_AVERAGE, TRAINING_PROGRESS; formulas in
  `src/lib/performance-formulas.ts`, documented in DECISIONS "Phase 5 Task 3"); versioned definitions (DRAFT > PENDING_APPROVAL >
  PUBLISHED > RETIRED) published only through the generic approval engine with separation of duties; computation per employee x period
  x job type / job category with a minimum sample and an explicit "not enough data"; append-only values with numerator, denominator,
  sample and evidence ids; scoped reads (employees see published versions only); a system entry point for a future worker.
- `coaching` (§10.4 coaching notes, "managers can add context", §22.2): coaching notes (private by default, shared one way, edited
  only by the author while private, archived never deleted) and manager context notes on a metric value or a period (behind the
  `coaching` field set); the correction API used by challenges (supersede, never overwrite).
- `data-challenges` (§10.4 "employees can challenge", §5.8 "employee-submitted corrections"): self-service raise / withdraw on one's
  own metric values (published), training records, shared coaching notes and qualifications; routing to a reviewer, HR decision
  (annotation, or a correction proven by the owning module: coaching in-transaction, qualifications and training records by audit
  reference); notifications.
- `development` (§10.4, §5.4 "recommend training", §5.8 "create development plans"): plans with goals, actions (linking a training
  assignment or coaching note) and append-only review history; deterministic, explainable training recommendations (expired / expiring
  TRAINING certification, a job type blocked only by missing training, a published metric value with enough data below the tenant's
  development threshold) that a person accepts (assignment, source RECOMMENDATION, same transaction) or dismisses with a reason; the
  tenant development thresholds (`OperationsSettings.developmentThresholds`).
- `development-dashboard` (§10.4): `GET /employees/{id}/development`, a read model composed only from the other modules' read
  functions: per-series values with history, evidence links, a POSITION among comparable colleagues in the viewer's scope (never a
  score, at least 4 people), strengths / development opportunities, OPEN recommendations, and coaching content only with the `coaching`
  field set.
- `customer-feedback` (§5.9, §10.2 "customer feedback"): manual recording by Customer Relations (rating and / or comment about a job and
  optionally one assigned employee), never edited, voided once with a reason.
- Self-service (§5.11, `/api/v1/me/**`, 11 GETs): own published metric values with evidence, shared coaching and context notes, training
  assignments and records, credentials, non-draft plans without the manager's notes, own challenges.
- Schema / catalog (Task 1): 14 new tables, permission modules `training`, `development_plans`, `coaching`, `data_challenges`,
  `customer_feedback`, `performance` extended (EDIT, MANAGE, CONFIGURE, PUBLISH), field set `performance.coaching_fields`, role
  templates per §4.5, seeded approval policy `performance_metric_publication`, labels in en-US / es-US / he-IL.

## 2. Changed files

`git diff --stat 3ce1935..HEAD -- leadro/`: about 205 files (the range also contains the Phase 4 review fixes merged at the start of
Phase 5). New modules `training`, `performance`, `coaching`, `data-challenges`, `development`, `development-dashboard`,
`customer-feedback` (each with a README); `self-service.ts` / `training-grants.ts` in qualifications; 69 new route files (291 in
total) under `/api/v1/training`, `/performance`, `/coaching`, `/data-challenges`, `/development-plans`, `/customer-feedback`,
`/employees/{id}/development` and `/me`; pure rules `src/lib/performance-formulas.ts`, `src/lib/metric-position.ts`; catalogs in three
locales; 23 new test files. Docs: `API_REFERENCE`, `ERD`, `PERMISSIONS`, `ARCHITECTURE`, `DECISIONS`, `reviews/phase5-review.md`, this
report.

## 3. Database changes (migrations after Milestone 4, in order)

1. `20261126100000_phase5_workforce`: TrainingCourse, TrainingAssignment, TrainingRecord, PerformanceMetricDefinition,
   PerformanceMetricValue, MetricContextNote, CoachingRecord, DevelopmentPlan, DevelopmentGoal, DevelopmentAction, DevelopmentPlanReview,
   TrainingRecommendation, DataChallenge, CustomerFeedback; RLS DO-block; CHECKs; status machines; frozen columns; no-delete;
   append-only metric values and plan reviews; the metric value guard and the definition content guard; employee-safe composite FKs;
   `PermissionAction.PUBLISH`, `ApprovalSubjectType.PERFORMANCE_METRIC_DEFINITION`.
2. `20261126150000_phase5_development_thresholds`: nullable `OperationsSettings.developmentThresholds JSONB` (+ CHECK array or NULL).

94 models in total (80 at Milestone 4), FORCE RLS on every tenant-owned table (`tests/db/rls.test.ts`). **No migration was added by the
review fixes.**

## 4. API changes (all under `/api/v1`, reference in `API_REFERENCE.md`)

New groups: `training` (courses, assignments, records, verify / reject / revoke, expiring), `training/recommendations` (list, get,
generate, accept, dismiss, thresholds), `development-plans` (plans, goals, actions, reviews, activate / complete / cancel),
`coaching` (records, context notes, share, archive), `data-challenges` (raise, list, get, assign, uphold, reject, withdraw),
`performance` (catalog, definitions, versions, submit, withdraw, retire, compute, values, employee values), `employees/{id}/development`,
`customer-feedback` (record, list, get, void), `me/*` (metrics, coaching-notes, context-notes, training assignments / records,
qualifications, development-plans, data-challenges). Review changes (section 8): records about the caller are `404` / `403` on the
module endpoints, editors of a definition version cannot approve it, the compute answer leaves out one's own previews, feedback about
oneself is refused, a challenged note's author cannot review the challenge.

## 5. Tests (final run, `leadro/`, real PostgreSQL 16, after the last commit)

| Check | Result |
|---|---|
| `npm test` (Vitest) | **182 files, 2490 tests: 2490 passed, 0 failed, 0 skipped** (581 s; 2471 at the end of Task 6, before the review) |
| `npm run typecheck` | passed, 0 errors |
| `npm run lint` | passed, 0 problems |
| `npm run i18n:check` | passed |
| `npm run build` | passed (Next.js production build, after `rm -rf .next`) |
| `npm run test:e2e` | not run for this milestone (no Phase 5 screen exists; the Phase 1 specs are unchanged) |

Error log lines printed by negative tests (trigger refusals, failing handlers) are expected. Phase 5 adds 23 test files: pure rule tests
(`performance-formulas`, `metric-position`), integration tests of every service against the real database (tenant isolation, scope,
field sets, self-service filters, separation of duties, append-only / frozen columns at the database, concurrency of open assignments /
recommendations / challenges / definition versions), route tests, the three spec 10.3 architecture tests, catalog keys per locale, the
schema test and the review regressions (`tests/phase5-hardening/phase5-review.test.ts`). **There is no end-to-end chain test**
(job -> metric -> published value -> recommendation -> assignment -> verified record -> qualification) beyond the per-link tests.

## 6. Known limitations and gaps (do not assume these exist)

- **No survey provider.** Customer feedback is entered by hand only (channel MANUAL); no import, no customer-facing survey.
- **No scheduler or worker.** Metric recomputation (`computeMetricValuesAsSystem`), the training sweep (`sweepAllTraining`),
  recommendation runs (`generateAllTrainingRecommendations`) and approval expiry are functions nobody calls on a schedule; today a
  manager runs a computation or a recommendation run by hand. Values are therefore as fresh as the last manual computation.
- **UI deferred**: no training, performance, coaching, plan, challenge, dashboard, feedback or self-service screen.
- **Compensation still BLOCKED (§28.4)**; no performance input to pay exists or is planned without the approved specification.
- No StorageProvider: training evidence is metadata only (no file). No `performance.export` endpoint. Dimensions WORK_QUALITY and
  PRODUCTIVITY have no kind (no defined data source, no invented formula). The `lead_team` record set is resolved by no service, so Lead
  Operations' Phase 5 grants match nothing (fail closed).
- A metric value cannot be CORRECTED through a challenge (only annotated): a value is append-only and its correction would be a
  recomputation naming the challenged value; not built.
- The approvals `createPolicySchema` accepts only `*.approve` approver permissions, so a tenant without the seeded publication policy
  cannot create one through the API (review P5-R9, deferred).
- Dashboard sections are separate read transactions (not one snapshot) and bounded (50 notes, 10 plans, 50 recommendations).
- Translations of the new TRAINING.* / PERFORMANCE.* / DEVELOPMENT.* / DATA_CHALLENGE.* / CUSTOMER_FEEDBACK.* keys in es-US and he-IL
  are machine-quality and need human review.
- Inherited: in-memory rate limiting, trigger-only audit immutability, MFA trust-on-first-use, provisional role templates (MILESTONE-1,
  MILESTONE-2-3, MILESTONE-4).

## 7. Security implications and the spec 10.3 protections

How "performance never automatically reduces work, removes eligibility, changes pay, reduces commissions or suspends" is enforced:

1. **No code path.** Dispatch, qualifications, jobs, ledger, payments, approvals, employees and finance-adjustments never import
   performance, development, development-dashboard or customer-feedback (`tests/performance`, `tests/development`,
   `tests/development-dashboard` `architecture.test.ts`), and never name a performance / coaching / development / challenge / feedback
   table (review P5-R7). The performance module imports only platform modules (approvals, audit, authz, core, db, notifications), so it
   cannot write work, eligibility or money records either; the dashboard imports only read functions.
2. **No data path.** No Phase 1-4 table references a Phase 5 table. The dispatch picture contains no performance data (§7.3).
3. **The only write into eligibility is legal, not performance**: a VERIFIED training record (an HR decision, never one's own) grants or
   renews the TRAINING qualification; a revoked record restates it from the remaining verified records. Spec 10.3 itself puts legal
   qualifications in the Qualification Engine.
4. **Human decisions.** Recommendations are deterministic, explained (reason codes + ids), never auto-assigned; "not enough data" never
   counts against anyone; thresholds feed training recommendations only.
5. **No universal score.** No endpoint or column sums, averages, ranks or weights across dimensions or employees; positions are per one
   version x period x breakdown, with at least 4 comparable people.
6. **Publication control.** A metric is visible to employees only once published; publication always needs an approval request (CHECK),
   the author, every editor (review P5-R3) and the requester never decide.
7. **Challenge path.** Employees challenge their own data; a challenge never silently edits data (annotation, or a correction proven by
   the owning module's audit event); the reviewer is never the raiser, the employee or the challenged note's author.

Sensitive data (§22.2): coaching notes, context notes, plans and challenges are behind their own sensitive permissions (MFA for custom
roles) and the `coaching` field set; records about oneself are never read through one's own management grant (review P5-R1); audit
events carry SHA-256 digests instead of free text; notifications carry no params and the employee's notices no link. RLS + FORCE on all
new tables. No security, HR-law or privacy review has been done (spec 22.3: employee monitoring, automated employment decisions, state
privacy laws).

## 8. Review results (`docs/reviews/phase5-review.md`)

Phase 5 ran in economy mode (no per-task reviewer), so a whole-phase review was done at the end. Each suspected defect was reproduced
with a failing test first.

| Id | Severity | Finding | Status |
|---|---|---|---|
| P5-R1 | Important | Coaching notes, context notes and plans (with review text) about the caller readable through their own management grant | Fixed |
| P5-R2 | Important | Managers could change / activate / cancel / review their own plan, decide their own recommendation, cancel their own assignment | Fixed |
| P5-R3 | Important | An editor of a draft metric definition could approve its publication | Fixed |
| P5-R4 | Minor | The compute answer returned the caller's own preview values | Fixed |
| P5-R5 | Minor | Customer feedback about oneself could be recorded or voided by the subject | Fixed |
| P5-R6 | Minor | The author of a challenged coaching note could review the challenge | Fixed |
| P5-R7 | Minor | The spec 10.3 architecture test checked imports, not direct table reads | Fixed (test) |
| P5-R8 | Minor | Notes can link a preview metric value the employee cannot open | Deferred (owner) |
| P5-R9 | Minor | No API to create a `performance.publish` policy | Deferred (approvals module) |

No Critical finding. RLS, append-only enforcement, the 10.3 boundaries, no universal score, field sets, self-service filters,
notification contents, audit without free text and the concurrency guards were checked and found sound.

## 9. Decisions for the owner's improvement round

Rulings taken by the manager or the task agents on the owner's behalf during Phase 5 (the owner asked to finish without waiting and
to review them at the end). None was reversed by the review. Each is one template line, one CHECK or one rule function to change.

**Process**
1. Economy mode: no per-task reviewer; manager verification per task plus this whole-phase review. UI deferred; compensation blocked.

**Schema and catalog (Task 1)**
2. COO sees metric values WITHOUT the coaching set and holds no coaching / plan / challenge permission (alternative: coaching set
   tenant-wide).
3. HR and the Owner author definitions; only the Owner publishes; a tenant whose Owner is the only author cannot publish until it grants
   `performance.publish` to someone else (alternative: COO or HR as publisher).
4. Metric publication ALWAYS needs an approval request (CHECK), unlike Phase 4 subjects ("no policy" = refused, not applied).
5. Challenges are decided by HR (and the Owner); managers only route them (alternative: management chain decides too).
6. Managers may run a computation (`performance.manage`, scoped); export stays Owner-only and has no endpoint.
7. Team Leader coaches (performance view + edit with the coaching set, coaching notes) and reads plans / training, but does not assign
   training, create plans or see challenges.
8. Lead Operations' coaching / training grants use the unresolved `lead_team` set (match nothing, fail closed).
9. Context notes default to NOT shared with the employee, like coaching notes.
10. Technician holds `training.view` OWN in addition to self-service; coaching, plans and challenges are self-service only.
11. Customer feedback is about one employee or nobody; never edited, voided once; only on the job's own customer.
12. Nothing is ever deleted (archive / cancel / void / retire); a legal erasure request would need a dedicated audited purge path (not built).
13. Dimensions WORK_QUALITY and PRODUCTIVITY exist but no kind measures them (no data source, no invented formula).
14. Review history is its own append-only table (`DevelopmentPlanReview`); other status changes are audit events.

**Training (Task 2)**
15. An assignment completes on VERIFICATION, not on recording; a revoked record leaves a completed assignment completed.
16. Expiry is fixed at recording (completion date + the course's `validityDays` then); a later validity change does not move records;
    the certification's own `validityMonths` is not used.
17. Verifying an older completion never shortens a newer qualification; an already-expired completion is history (no qualification);
    a qualification HR changed by hand is left alone; the certification's `requiresNumber` is not enforced for course-granted rows.
18. Archived courses refuse new assignments but accept completions; due dates cannot be in the past; overdue is derived.
19. The notification sweep has no claim columns and relies on the engine's idempotency key; "expired" looks back 7 days; an employee
    without `training.view` (a Dispatcher) gets no training notification (self-service shows it).

**Performance (Task 3)**
20. The formula catalog choices: repeat visits count only after their window elapsed; early arrival is on time; a submitted completion
    is complete; outcome conversion counts SOLD / NOT_SOLD only; visits are attributed to the LEAD assignment at completion.
21. One kind per key; content editable only while DRAFT and before any value was computed; one open version per key; params stored
    normalized.
22. Values follow the employee's CURRENT placements for scope (a manager stops seeing someone who left the unit); previews visible to
    configure / manage holders, never about oneself; retiring needs no approval.
23. Values are append-only; the newest `computedAt` is current; at most 10,000 evidence ids per value and 366 days per period.

**Coaching and challenges (Task 4)**
24. Context notes use the performance permissions (`performance.edit` / `.view` with the coaching set) and live under
    `/api/v1/coaching/context-notes`.
25. Only the author edits a coaching note, only while private; sharing is one way for both note kinds; correcting a shared note
    supersedes it (archive + corrected copy), never overwrites.
26. Nobody writes coaching or context notes about themselves.
27. Only the ASSIGNED reviewer decides a challenge (assign yourself first); an OPEN challenge must be routed before it is decided;
    values of RETIRED definitions cannot be challenged; metric values can be annotated only (no correction path).
28. Challenge statements and resolutions are visible to every `data_challenges.view` holder (no extra field set); the employee's
    decision notice has no link and no text.

**Development (Task 5)**
29. One extra migration (`OperationsSettings.developmentThresholds` JSONB) instead of a generic settings column.
30. Thresholds are integers in thousandths (`belowMilli`), one per metric key; REPEAT_VISIT_RATE thresholds are refused (lower is better).
31. JOB_TYPE_TRAINING_MISSING only when missing / expired training is the SOLE blocker of the job type.
32. Recommendation runs are explicit (endpoint / worker function); a person's dismissal sticks until a new reason appears; the system
    dismisses lapsed ones (`NO_LONGER_APPLIES`, `ALREADY_ASSIGNED`); no notification for new recommendations.
33. Nobody runs a plan about themselves; the owner must be able to edit it; linked records must be visible to the caller.

**Read models and feedback (Task 6)**
34. "Team" for peer positions = the VIEWER's scope, not the value's unit snapshot; a position needs at least 4 comparable people; ties
    count half; only published versions are on the dashboard; challenges are not on it.
35. Self-service plans hide DRAFTs, review text, reviewer and cancel reason (alternative: show review text).
36. Feedback is scoped by the job's unit with no second gate on the customer; the named employee must have worked the job; feedback on
    jobs of any status is accepted.

**From this review (owner decisions)**
37. Records about oneself are out of reach of one's own management grants (P5-R1/R2). Should HR staff and managers ALSO see their own
    private notes / plan review text? Today: no (only what is shared, through self-service).
38. P5-R8: refuse linking a preview metric value to a note, or hide the id in self-service?
39. P5-R9: allow `performance.publish` (and other non-`*.approve` publisher permissions) in approval policy creation?

## 10. Remaining tasks

A scheduler / worker (metric recomputation, training sweep, recommendation runs, approval expiry, notification delivery); a survey
provider; the Phase 5 UI (manager dashboard, HR training / plan / challenge workspaces, employee self-service screens); the
compensation specification and module (§28.4); a correction path for metric values; the `lead_team` record set; StorageProvider for
training evidence; exports; the deferred review items (P5-R8, R9) and the owner's decisions in section 9; an end-to-end workforce
chain test; HR / privacy / legal review (spec 22.3); Phase 8 hardening.
