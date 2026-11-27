# Phase 5 whole-phase review (workforce intelligence)

Scope: `git diff 3ce1935..HEAD -- leadro/` restricted to Phase 5: the modules `training`, `performance`, `coaching`,
`data-challenges`, `development`, `development-dashboard`, `customer-feedback`, the `qualifications` additions
(`training-grants.ts`, `self-service.ts`), the `/api/v1/me/**` read models, every new route, the role templates / catalog
additions and the migrations `20261126100000_phase5_workforce` and `20261126150000_phase5_development_thresholds`. (The same
range also contains the Phase 4 review fixes in `ledger`, `payments`, `finance-adjustments` and `approvals`; those were reviewed
in `phase4-review.md` and are out of scope here.)

Phase 5 ran in economy mode (no per-task reviewer), so this is the first independent review of the whole phase. Manager rulings
(DECISIONS.md "Phase 5 Task 1".."Task 6" and the SDD ledger) are not findings; they are listed for the owner in `MILESTONE-5.md`.

Every finding marked as reproduced was shown with a failing test against the real test database before the fix. The regression
tests are in `tests/phase5-hardening/phase5-review.test.ts` (and the architecture test extension for P5-R7).

## Findings

| Id | Severity | Where | Status |
|---|---|---|---|
| P5-R1 | Important | `src/server/coaching/coaching-records.ts:170,181`, `src/server/coaching/context-notes.ts:138,153`, `src/server/development/plans.ts:187,198`, `src/server/development-dashboard/dashboard.ts:190` | Fixed |
| P5-R2 | Important | `src/server/development/plans.ts:57` (`loadPlanForChange`), `src/server/development/recommendations.ts:195` (`loadOpenForDecision`), `src/server/training/assignments.ts:109` (`loadForChange`) | Fixed |
| P5-R3 | Important | `src/server/performance/publication.ts:55` (`excludedApproverIds`), `src/server/performance/definitions.ts` (`updateDefinition`) | Fixed |
| P5-R4 | Minor | `src/server/performance/compute.ts:180` (`computeMetricValues` answer) | Fixed |
| P5-R5 | Minor | `src/server/customer-feedback/feedback.ts:65,112` | Fixed |
| P5-R6 | Minor | `src/server/data-challenges/review.ts` (`assertEligibleReviewer`) | Fixed |
| P5-R7 | Minor | `tests/performance/architecture.test.ts` (spec 10.3 test checks imports only) | Fixed (test extended) |
| P5-R8 | Minor | `src/server/coaching/access.ts:47` (`assertMetricValueOfEmployee`), `context-notes.ts:53` | Deferred |
| P5-R9 | Minor | `src/server/approvals/schemas.ts` (`createPolicySchema` accepts only `*.approve`) | Deferred (already a known gap, DECISIONS "Phase 5 Task 3") |

No Critical finding.

### Checked and found sound

- **Spec 10.3 structural protection.** No deciding module (dispatch, qualifications, jobs, ledger, payments, approvals, employees,
  finance-adjustments) imports performance, development, development-dashboard or customer-feedback (three architecture tests), and
  none reads a performance / coaching / development / challenge / feedback table directly (grep of every Prisma delegate and table
  name outside the Phase 5 modules: only `qualifications/training-grants.ts`, which is the training -> TRAINING certification path
  that spec 10.3 itself puts in the Qualification Engine). The only Phase 5 write into eligibility is a VERIFIED training record
  granting / renewing / restating a TRAINING qualification, an HR decision on a training record, never a metric. Recommendations are
  never auto-assigned (accept is a person, in one transaction with the assignment). There is no compensation module; nothing
  touches employment status. P5-R7 makes the "no direct table read" part a test.
- **No universal score.** No endpoint or read model sums, averages, ranks or weights across definitions or employees; values
  carry numerator / denominator / sample / `enoughData`; the dashboard position is per one version x period x breakdown with at
  least 4 comparable people, ties at mid-rank, integer comparison; strengths / opportunities are lists of series, not a number.
  Thresholds are per metric key and feed training recommendations only.
- **RLS.** All 14 new tables are in the fail-closed ENABLE + FORCE DO-block and in `tests/db/rls.test.ts`; the second migration
  adds a column to an already covered table.
- **Append-only / immutability.** Metric values and plan reviews reject UPDATE / DELETE / TRUNCATE; every other Phase 5 table has
  no-delete, frozen columns and a status machine trigger; the value guard enforces `enoughData = sampleSize >= minSample`, the
  breakdown per kind and the actor XOR; definition content is frozen after DRAFT; feedback is voided once.
- **Authorization.** Every service re-checks in its transaction (`enforceInTx` capability first, then scope over the EMPLOYEE, 404
  outside it); field set `coaching` gates context notes and the dashboard's coaching sections; self-service filters on
  `actor.employeeId` only and hides drafts, review text, cancel reasons, private / archived notes, previews; peers are only values
  the viewer may already read (no employee id or peer value leaves the read model). Challenge raiser never reviews (service + CHECK),
  only the assigned reviewer decides, routers cannot route their own challenge.
- **SoD in metric publication** beyond P5-R3: the requester is excluded by the engine, the author by `excludedApproverIds`, the
  publication always needs an approval request (CHECK), the Owner who is the only author cannot publish (ruling 2).
- **Audit** on every mutation, with SHA-256 digests instead of free text (coaching, context notes, plans, goals, actions, reviews,
  reasons, feedback comments, challenge statements are never in an audit event).
- **Notifications** carry no params; links are re-authorized at read time (`training.view`, `data_challenges.view`); the employee's
  `data_challenge.decided` and `development_plan.activated` carry no link.
- **Concurrency.** One open assignment per employee + course, one OPEN recommendation per pair (`ON CONFLICT DO NOTHING`), one open
  challenge per record, one open / one PUBLISHED definition version per key (key row lock + partial unique indexes), row locks on
  every decision path.

## P5-R1 (Important): coaching content about oneself was readable through a management grant

**Scenario.** The City A manager is placed in City A and holds `coaching.view`, `development_plans.view` and `performance.view`
(with the `coaching` set) over City A, so their own employee record is inside their own scope. The State manager writes a
private coaching note about them, a private context note on their metrics and a development plan with a review entry. The City A
manager then reads all three through `GET /coaching/records`, `/coaching/context-notes`, `/development-plans/{id}` and their own
`GET /employees/{id}/development`, including the review text that the self-service plan view deliberately hides (Task 6 ruling)
and notes that were never shared. The same holds for HR staff (tenant-wide grants) about their own record. The performance module
already applies "own values stay published-only, for managers too"; the coaching and plan reads had no equivalent rule.

**Fix.** Reads of coaching notes, context notes and development plans exclude records about the caller (`employeeId <> caller`
in the list query, 404 on a single read); the caller reads what was shared with them through `/api/v1/me/*`. The dashboard
inherits it (its sections call these functions). Regression: "P5-R1" (4 cases).

## P5-R2 (Important): managers could act on their own development records

**Scenario.** Creating a plan or a coaching note about oneself was refused, but every later change was not: the City A manager
could rewrite, activate or cancel the plan their State manager created for them and add their own review entry; dismiss (or
accept) a training recommendation about themselves; push back the due date of, or cancel, a training assignment their manager
gave them. Same principle as "nobody verifies their own training record" (§21.3).

**Fix.** `loadPlanForChange` (every plan, goal, action and review change), `loadOpenForDecision` (accept / dismiss) and the training
assignment `loadForChange` (PATCH / start / cancel) refuse a record about the caller with `403`. Assigning training to oneself and
recording one's own completion stay allowed (a second person verifies it). Regression: "P5-R2" (3 cases, one proving managers still
manage their people's training).

## P5-R3 (Important): the person who edited a draft definition could approve its publication

**Scenario.** HR creates a metric definition (DRAFT). The Owner, who holds both `performance.configure` and `performance.publish`,
changes it (`PATCH`, e.g. the minimum sample or the window). HR submits it. Only the author (`createdById`) and the requester were
excluded from deciding, so the Owner approved the publication of content they wrote. Phase 4's rule is "the requester and named
editors / submitters never decide".

**Fix.** `submitDefinition` excludes the author AND every user who edited that version (`performance_metric_definition.update`
audit events of the version, the only place the editors are recorded; no migration). Regression: "P5-R3".

## P5-R4 (Minor): a computation answered with the caller's own preview values

**Scenario.** A manager computes a DRAFT (never published) definition for their unit; the stored rows are fine, but the answer of
`POST /performance/definitions/{id}/compute` listed every written value, including the manager's own preview, which every read
endpoint hides ("own values stay published-only").

**Fix.** For a version that was never published, the answer leaves out the caller's own row (`employeeCount` still counts them,
the row is stored and audited). Regression: "P5-R4".

## P5-R5 (Minor): feedback about oneself could be recorded or voided by the subject

**Scenario.** A user holding `customer_feedback.create / .edit` who also worked the job could record a 5-star rating about
themselves, or void a 1-star one, which then counts (or stops counting) in their CUSTOMER_FEEDBACK_AVERAGE metric.

**Fix.** Recording feedback that names the caller's own employee record, and voiding feedback about the caller, are `403`. Feedback
about the job only is unaffected. Regression: "P5-R5".

## P5-R6 (Minor): the author of a challenged coaching note could be its reviewer

**Scenario.** HR writes and shares a coaching note; the employee challenges it; the router assigns the challenge to the same HR
user, who then decides whether their own note was inaccurate.

**Fix.** `assertEligibleReviewer` also refuses the author of the challenged coaching note (400 on `reviewerUserId`, like the raiser).
Regression: "P5-R6".

## P5-R7 (Minor): the spec 10.3 architecture test checked imports, not table reads

**Scenario.** A deciding module (dispatch, say) could read `tx.performanceMetricValue` directly and no test would notice.

**Fix.** `tests/performance/architecture.test.ts` also asserts that no deciding module names a Phase 5 Prisma delegate or table
(qualifications may touch `trainingRecord` only in `training-grants.ts`, the legal TRAINING certification path).

## P5-R8 (Minor, deferred): notes can link to a metric value the employee cannot see

A coaching note or context note may link a metric value of a never-published (preview) version. Shared, the employee sees a
`metricValueId` that `/me/metrics/{id}` answers with 404. Nothing leaks (an id only), the note text is the author's. Options:
refuse linking previews, or null the id in self-service. Deferred to the owner (managers may want to annotate a preview).

## P5-R9 (Minor, deferred): a tenant without the seeded publication policy cannot create one

Already recorded in DECISIONS.md "Phase 5 Task 3 / Known gaps": `createPolicySchema` accepts only `*.approve` approver permissions,
so `performance.publish` policies can only come from the seed. Belongs to the approvals module.
