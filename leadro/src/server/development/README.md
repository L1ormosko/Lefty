# development

Development plans and training recommendations (§10.4, §5.4, §5.8, §28.6). Decisions: `docs/DECISIONS.md` "Phase 5 Task 5";
permissions: `docs/PERMISSIONS.md` section 12; tables: `docs/ERD.md` "Phase 5".

Public API (`index.ts`):
- Self-service (Task 6, no module permission): `listOwnPlans`, `getOwnPlan` = own ACTIVE / COMPLETED / CANCELLED plans without the
  manager's private notes (review text and reviewer, cancel reason, links to unshared coaching notes).
- Plans (`development_plans.view / .create / .edit` over the EMPLOYEE): `createPlan`, `updatePlan`, `activatePlan`,
  `completePlan`, `cancelPlan`, `getPlan`, `listPlans`; `addGoal`, `updateGoal`, `addAction`, `updateAction`, `addReview`.
- Recommendations (`training.view` to read, `training.assign` to run / decide, over the employee): `generateRecommendations`
  (one employee or everyone ACTIVE in scope), `acceptRecommendation` (+ optional TRAINING action in a plan),
  `dismissRecommendation`, `getRecommendation`, `listRecommendations`. System runs: `generateTrainingRecommendationsForTenant`,
  `generateAllTrainingRecommendations` (no scheduler exists; a worker calls them).
- Thresholds of the metric rule: `getDevelopmentThresholds` (`training.view`), `updateDevelopmentThresholds` (`training.manage`
  TENANT), stored on `OperationsSettings.developmentThresholds` (null = rule disabled).

Routes: `/api/v1/development-plans[/{id}[/activate|/complete|/cancel|/goals[/{goalId}]|/actions[/{actionId}]|/reviews]]`,
`/api/v1/training/recommendations[/{id}[/accept|/dismiss]|/generate|/thresholds]`.

Invariants:
- Plans: DRAFT > ACTIVE > COMPLETED, DRAFT / ACTIVE > CANCELLED (reason); only DRAFT / ACTIVE plans change; reviews are
  append-only and snapshot the plan status. Nobody runs a plan about themselves; the owner can edit it and is not the employee.
  Linked assignments / coaching records are the plan employee's and visible to the caller. No free text in audit events
  (SHA-256 digests of titles, summaries, descriptions, reviews, reasons).
- Recommendations come only from the rules in `rules.ts` (deterministic; every reason is a code + ids / numbers, labelled
  `TRAINING.RECOMMENDATION_REASON.<code>`) and only when a run is requested. They are never auto-assigned: accepting creates
  the assignment (`createTrainingAssignmentInTx`, source RECOMMENDATION) in the same transaction; an open assignment is a 409.
  One OPEN per employee + course (DB). A run dismisses as the system (`decidedById` null) what no longer applies
  (`NO_LONGER_APPLIES`, `ALREADY_ASSIGNED`) and does not re-raise a finding a person already decided.
- Development use only (§10.3): this module reads qualifications (read functions only) and published metric values; nothing
  that decides work, pay or employment imports it (`tests/development/architecture.test.ts`). "Not enough data" never counts.
- Employees read their own non-DRAFT plans through self-service (Task 6); they are told when a plan becomes active (no link).
