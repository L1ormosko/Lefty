# training

Training catalog, assignments and completion records (§10.1 "Training", §5.4, §5.8). Decisions: `docs/DECISIONS.md`
"Phase 5 Task 2"; permissions: `docs/PERMISSIONS.md` section 12; tables: `docs/ERD.md` "Phase 5".

Public API (`index.ts`):
- Self-service (Task 6, no module permission, own rows, with the course summary): `listOwnAssignments`, `listOwnRecords`.
- Courses: `listCourses`, `getCourse`, `createCourse`, `updateCourse`, `archiveCourse`. Tenant-wide reference data: any
  `training.view` reads, `training.manage` at TENANT scope changes. A course may grant a TRAINING-type certification.
- Assignments: `assignTraining` (`training.assign`), `updateAssignment` / `startAssignment` / `cancelAssignment`
  (`training.edit`), `getAssignment` / `listAssignments` (`training.view`, `overdue=true` filter).
  `createTrainingAssignmentInTx(tx, ctx, { employeeId, courseId, dueDate, note, source, recommendationId })` is for
  Task 5 (accepting a recommendation, `source = RECOMMENDATION`): no permission check, returns `{ assignment,
  notificationIds }`; wrap the caller's `withTenant` in `conflictOnUniqueViolation(TRAINING_ASSIGNMENT_ALREADY_OPEN, ...)`.
- Records: `recordCompletion` (`training.create`), `getRecord` / `listRecords` (`training.view`), HR's `verifyRecord`,
  `rejectRecord`, `revokeRecord` (`training.approve`, never on one's own record).
- Expiry: `listExpiringRecords` (scoped API), `findExpiringTrainingRecords` / `findOverdueTrainingAssignments` (system
  queries), `sweepTraining(tenantId)` / `sweepAllTraining()` (notifications; no scheduler exists, a worker calls them).

Routes: `/api/v1/training/courses[/{id}[/archive]]`, `/api/v1/training/assignments[/{id}[/start|/cancel]]`,
`/api/v1/training/records[/{id}[/verify|/reject|/revoke]|/expiring]`.

Invariants:
- Assignments and records are scoped by the EMPLOYEE's data scope; out of scope is a 404.
- One open assignment per employee and course (409). Overdue is derived (open, due before the tenant-local today).
- Evidence is metadata only (no StorageProvider, §28.3); the completion and its evidence never change after recording.
- `expiresAt` = tenant-local completion date + the course's `validityDays` when recorded.
- Verifying completes the open assignment and, for a course granting a certification, creates / renews (never shortens)
  the TRAINING qualification through `@/server/qualifications` (so eligibility sees it). Revoking re-derives it from the
  remaining verified records (none: revoked).
- Nothing here reads or writes performance data, and dispatch never reads this module (§10.3); eligibility only sees the
  resulting qualification.
