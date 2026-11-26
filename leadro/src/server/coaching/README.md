# coaching

Coaching records and manager context notes on metric values (spec 10.4 "coaching notes", "managers can add context";
22.2 sensitive data). Routes: `/api/v1/coaching/records/**` and `/api/v1/coaching/context-notes/**`
(`docs/API_REFERENCE.md` "Coaching"). Decisions: `docs/DECISIONS.md` "Phase 5 Task 4".

Public API (`index.ts`):
- Self-service (Task 6, no module permission): `listOwnSharedCoachingRecords`, `listOwnSharedContextNotes` (shared, not archived).
- Coaching records: `createCoachingRecord`, `updateCoachingRecord` (author, private notes only), `shareCoachingRecord`,
  `archiveCoachingRecord`, `getCoachingRecord`, `listCoachingRecords`. Permissions `coaching.view` / `.create` / `.edit` over the
  record's EMPLOYEE (`view` is sensitive).
- Context notes: `createContextNote`, `shareContextNote`, `archiveContextNote`, `getContextNote`, `listContextNotes`. Permissions
  `performance.edit` (write) / `performance.view` (read) whose matching grant names the `coaching` field set
  (`performance.coaching_fields`); without it a note is a 404 and lists are empty.
- **`supersedeCoachingRecordInTx(tx, { tenantId, coachingRecordId, employeeId, body, challengeId, ctx })`**: the correction API
  the `data-challenges` module calls when it upholds a challenge of a shared note. Archives the note, creates the corrected copy
  and returns the `coaching_record.correct` audit event id. No permission check: the caller authorized the reviewer.
- `textDigest(body)`: SHA-256 hex of a text, what audit events record instead of the text.

Invariants:
1. Employee and author never change; context notes' text and subject never change (DB triggers). Nothing is deleted (archive).
2. Private by default (`sharedWithEmployee = false`, ruling 8); sharing is one way and sets `sharedAt` (DB CHECK).
3. A coaching note's text changes only while private and only by its author; once shared, only through an upheld data
   challenge, which keeps the challenged version (archived) next to the corrected one.
4. Nobody writes coaching or context notes about themselves. A linked metric value must be the same employee's.
5. No free text in audit events: text changes are recorded as `bodySha256` digests.
6. This module reads `PerformanceMetricValue` rows (owner and period) but never writes performance data; nothing in dispatch,
   eligibility or compensation imports it (spec 10.3).
