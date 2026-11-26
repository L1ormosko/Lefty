# LEADRO — Implementation Plan: Phase 5 (Workforce Intelligence) — backend

Spec: `leadro/docs/SPEC.md` (binding), especially Part 10 (§10.1–10.4), §2 principles (performance never
determines access to work), §4.5 matrix row "Performance", §5.4 manager actions, §5.8 HR workspace,
§5.11 employee self-service, §22.2 sensitive data, the default-settings table (performance = development
use; performance-based job exclusion prohibited). Scope decision: UI deferred (owner). Phase 5 builds on
the Phase 2 qualification engine (skills, certifications, licenses, equipment, TRAINING kind already exist).

## Global Constraints (Phase 1–4 constraints still bind)

- §10.3 is structural, not a policy flag: performance data never feeds dispatch eligibility, ranking,
  assignment, compensation, commissions, suspensions or employment status. The performance/development
  modules expose read models only; they import nothing that writes those records, and an architecture test
  asserts that dispatch/qualifications/jobs/ledger/approvals/employees never import the performance modules.
- No universal score (§10.4): no endpoint or field combines dimensions into one number. Every metric value
  is per dimension, per job type (or job category), per period, with its sample size, the opportunities
  denominator and evidence (ids of the underlying records), and a "not enough data" state below the
  definition's minimum sample.
- Metric definitions are versioned; a definition is visible to the employee only once published, and
  publishing goes through the generic approval engine (`registerApprovalSubject`, SoD). Formulas are a
  fixed, documented catalog of computable kinds over real data (no invented weights, no targets/thresholds
  that trigger actions). Compensation stays BLOCKED (§28.4).
- Employees can challenge inaccurate information (§10.4, §5.8 "employee-submitted corrections"):
  challenges are records with a lifecycle; a challenge never silently edits data — a resolution either
  annotates, or the owning module performs the correction with audit.
- Coaching notes, development plans and challenges are sensitive (§22.2): own field set
  (`performance.coaching`), scoped to the employee's management chain + HR; the employee sees their own
  plans and the notes marked shared.
- Recommendations (training) are deterministic, rule-based and explainable (every reason shown), and
  human-approved; never auto-assigned (§28.6 principle, same as dispatch recommendations).
- Same module/pipeline/RLS/audit/i18n/doc rules; new migrations only in Task 1.

## Task 1: Phase 5 schema + permission catalog
TrainingCourse (code, name, category, optional Certification of type TRAINING it grants, validity days,
active), TrainingAssignment (employee, course, due, status, assignedBy, source: MANUAL | RECOMMENDATION),
TrainingRecord (employee, course, completedAt, evidence ref, recordedBy, verifiedBy, expiresAt),
PerformanceMetricDefinition (key, kind from the catalog, dimension, version, params JSON, minSample,
status DRAFT | PENDING_APPROVAL | PUBLISHED | RETIRED, approval ref), PerformanceMetricValue (definition
version, employee, period, job type/category, numerator, denominator, sample, evidence ids, computedAt;
append-only snapshots — recomputation writes a new row), MetricContextNote (manager context on a value
or period), CoachingRecord (employee, author, sharedWithEmployee, body, linked metric/value), DevelopmentPlan
(employee, owner, status, period) + DevelopmentGoal + DevelopmentAction (training/coaching/other link),
TrainingRecommendation (employee, course, reasons JSON, status OPEN | ACCEPTED | DISMISSED with reason),
DataChallenge (employee, target type/id, statement, status OPEN | UNDER_REVIEW | UPHELD | REJECTED |
WITHDRAWN, resolution, reviewer), CustomerFeedback (job, customer, rating 1-5?, comment, channel MANUAL,
recordedBy) — manual entry only (no survey provider). Permission catalog: training.*, development_plans.*,
coaching.*, performance.* (extend with CONFIGURE, PUBLISH), data_challenges.*, customer_feedback.*;
templates per §4.5 (HR full training/plans; managers scoped; Lead Team own team; employee own via self
paths). Field set `performance.coaching`. RLS + tests.

## Task 2: Training catalog, assignments, records (§10.1 Training, §5.8)
Course CRUD; assign (manual) with due dates; record completion with evidence metadata (StorageProvider
not configured → metadata only); HR verification; a verified record of a course that grants a TRAINING
certification creates/renews the EmployeeQualification through the qualifications module (so the
eligibility engine sees it); expiry-aware; overdue/expiring queries + notifications. APIs `/api/v1/training/*`.

## Task 3: Performance engine (§10.2)
Metric kind catalog (documented formulas, each with numerator/denominator/evidence from existing data):
repeat-visit rate (same customer + job type re-visit within N days), on-time arrival (arrival verification
inside the appointment window), documentation completeness (completion form submitted / required fields),
outcome conversion (successful outcomes / completed visits), recovery conversion (recovery employees),
customer feedback average (manual feedback), training progress (completed / assigned). Definitions
versioned, publish via approval engine; computation per employee × period × job type with minimum sample;
values append-only with evidence; read APIs scoped; employee sees only PUBLISHED definitions' values.
Architecture test for §10.3. APIs `/api/v1/performance/*`.

## Task 4: Coaching, context notes, data challenges (§10.4)
Coaching records (shared/private), manager context notes on metric values, employee challenges on metric
values / training records / coaching notes shared with them / qualification records; review workflow
(assign reviewer, uphold → annotation or correction through owning module, reject with reason); audit,
notifications to reviewer and employee. APIs `/api/v1/coaching/*`, `/api/v1/data-challenges/*`.

## Task 5: Development plans + training recommendations (§10.4, §5.4, §5.8)
Plans with goals and actions (link training assignment / coaching), status, review history (append-only
review entries); recommendation rules (expiring/expired TRAINING certification; job types the employee
was ineligible for because of a missing training requirement; published metric value below the tenant's
configured development threshold with enough sample — development use only, never dispatch); explanations;
manager accepts (→ training assignment, source RECOMMENDATION) or dismisses with reason. APIs
`/api/v1/development-plans/*`, `/api/v1/training/recommendations/*`.

## Task 6: Read models — manager development dashboard + employee self-service (§10.4, §5.11)
Manager view per employee: strengths / development opportunities (published values compared with the
team's same-job-type distribution — shown as a position with sample sizes, never a single score),
recommendations, history (values over periods), evidence drill-down, coaching notes, review history.
Self-service: own published metrics with evidence, own training records/assignments, certification status,
own plans, own challenges. Customer feedback recording by Customer Relations. APIs `/api/v1/me/*` extensions
and `/api/v1/employees/{id}/development`.

## Task 7: Hardening + MILESTONE-5
Whole-phase review, fixes, docs (ERD, PERMISSIONS, API_REFERENCE drift, ARCHITECTURE), `docs/MILESTONE-5.md`
(§28.7) with limitations (no survey provider, no scheduler for recomputation/sweeps, UI deferred) and the
manager rulings for the improvement round.
