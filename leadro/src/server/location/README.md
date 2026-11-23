# location

Location events (§17, §22.2) and the offline gate for field writes (§8.7, §25.3). Routes `/api/v1/location-events/**`
(`docs/API_REFERENCE.md` "Location events"). Pure rules: `src/lib/location-rules.ts`. Design: `DECISIONS.md` "Phase 3 Task 2".

Public API (`index.ts`):
- `recordLocationEventInTx(tx, input)`: the ONLY writer of `LocationEvent`. Validates accuracy (mandatory with a position), the device clock for
  device sources, an author for manager entries. Authorization is the CALLER's job. The result has NO coordinates.
- `latestValidLocation(tx, employeeId, { tenantId, maxAgeMinutes, maxAccuracyM })`: newest position that is fresh and accurate enough, or null.
  INTERNAL: it carries coordinates for arrival (Task 3) and recovery presence (Task 6) to turn into distances / statuses; never return it.
- `purgeExpiredCoordinates(tenantId)`: retention. Nulls latitude / longitude of events older than `locationRetentionDays` and stamps
  `coordinatesPurgedAt`; rows stay (shifts, arrivals, recovery cases reference them). No scheduler yet; audited as a system event.
- `runFieldEvent(request, { apply, replay })`: idempotent processing per `(tenant, employee, clientEventId)` through `FieldEvent`.
- `recordLocationEvent` (technician's DEPARTURE / NAVIGATION_OPENED), `listLocationEvents`, `getLocationEvent`, `loadLocationSettings`, schemas.

Invariants:
- Event-based only (§17.1): no polling endpoint. NAVIGATION_OPENED never touches a job and is never an arrival (§8.3).
- Each event keeps accuracy, device time AND server time, and its source. GPS is a reported estimate, never proof (§17.2).
- Raw coordinates live ONLY in `LocationEvent` and are returned only to a grant naming the `coordinates` field set; managers get time, kind, accuracy,
  distance and verdicts. Audit values and `FieldEvent.payload` never hold coordinates (`runFieldEvent` throws if a payload does).
- Same clientEventId + same content = replay (original answer); different content = 409; a refused event is stored REJECTED and refused again.
