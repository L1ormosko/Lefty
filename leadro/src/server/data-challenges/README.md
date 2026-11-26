# data-challenges

Employees challenge inaccurate information about themselves (spec 10.4, 5.8 "employee-submitted corrections", 5.11): a
metric value, a training record, a coaching note shared with them, or a qualification record. Routes:
`/api/v1/data-challenges/**` (`docs/API_REFERENCE.md` "Data challenges"). Decisions: `docs/DECISIONS.md` "Phase 5 Task 4".

Public API (`index.ts`):
- Self-service (no module permission; the record must be the caller's own): `raiseDataChallenge`, `withdrawDataChallenge`
  (the raiser only, else 404).
- Review: `assignDataChallengeReviewer` (`data_challenges.assign`: managers and HR route), `upholdDataChallenge`
  (`data_challenges.approve`) and `rejectDataChallenge` (`data_challenges.reject`): HR and the Owner decide (ruling 4).
- Read: `getDataChallenge`, `listDataChallenges` (`data_challenges.view`, sensitive; scope = the employee's).
- `CORRECTION_PATH`: how a CORRECTED resolution is proven per target type. `registerDataChallengeNotificationTarget()`.

Lifecycle (DB status machine): OPEN -> UNDER_REVIEW -> UPHELD | REJECTED; OPEN / UNDER_REVIEW -> WITHDRAWN. Re-routing keeps
UNDER_REVIEW. One open challenge per record (partial unique index, 409).

Invariants:
1. The target is read from its own table inside the transaction: it must be the caller's (else 404) and visible to them
   (metric value of a PUBLISHED definition; coaching note shared and not archived). Statement and target are frozen (DB).
2. The person who raised a challenge, and the challenged employee, never review or decide it (service + DB CHECK). The
   reviewer must hold `approve` AND `reject` over the employee; only the assigned reviewer decides.
3. Never a silent edit. ANNOTATED stores the annotation. CORRECTED requires proof from the owning module: a coaching note is
   corrected here through `supersedeCoachingRecordInTx` (challenged version archived, corrected copy created); a
   qualification is corrected first through `/api/v1/qualifications/*` and the reviewer names that audit event, which must be
   about this record, successful and newer than the challenge. Metric values and training records can only be annotated
   until their modules offer a correction API (hand-off in DECISIONS). `resolutionDetails` holds the audit event id.
4. Notifications: routers (`data_challenges.assign` over the employee's units) on raise, the reviewer on assignment (both
   link to the challenge, re-authorized at read time), the employee on a decision (no link, no text). No free text in
   notifications or audit events.
5. Nothing is deleted (DB trigger). This module imports nothing from dispatch, jobs, compensation or eligibility (spec 10.3).
