# shifts

Work shifts (§8.1) and the exceptions around starting and ending them (§17.4). Routes `/api/v1/shifts/**`
(`docs/API_REFERENCE.md` "Shifts"). Pure capture rules: `src/lib/shift-rules.ts`. Design: `DECISIONS.md` "Phase 3 Task 2".

Public API (`index.ts`):
- `startShift`, `endShift` (own shift, or a manager's correction with a reason), `reviewShiftException` (`shifts.approve`).
- Reads: `getShift`, `getCurrentShift`, `listShifts`, and `shiftRef` (the `requirePermission` resolver for `/shifts/{id}` routes).
- Schemas and `SHIFT_FIELD_MAP`.

Invariants:
- One ACTIVE shift per employee (DB partial unique index, plus a row lock on the employee), so start is idempotent: a running shift is returned.
- A boundary is a device position (accuracy mandatory) OR a stated exception (GPS off, permission denied, offline ...: a manual entry with a
  reason). An exception, or a position vaguer than `locationMaxAccuracyM`, queues the shift for review (`exceptionReviewStatus PENDING`).
- Every boundary writes a SHIFT_START / SHIFT_END location event (through `@/server/location`) in the same transaction, and an audit event.
  A shift itself holds no coordinates; audit values never hold them either.
- Offline: `clientEventId` + `occurredAt` go through `runFieldEvent` (`field-events` module): a replay answers with the original shift.
- Scope: ORG_UNIT follows the placement SNAPSHOT taken at start (`Shift.orgUnitId`), OWN the technician's own. Out of scope is 404.
- Nobody reviews their own shift; a review is decided once, with a mandatory note.

Not here: job status changes (jobs module only), arrival verification (Task 3), notifications for pending reviews (not built; see DECISIONS).
