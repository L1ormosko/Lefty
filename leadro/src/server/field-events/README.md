# field-events

Owns the offline gate every field writer goes through (spec 8.7, 25.3). Imports nothing but `core`, `db`, `logging`
and the pure `location-rules` helper, so any module may depend on it.

Public: `runFieldEvent(request, { apply, replay })`, `withFieldEventBatch`, `assertBelievableEventTime(occurredAt, now)`.

Invariants
- Idempotent per `(tenant, employee, clientEventId)` (unique index on `FieldEvent`); concurrent copies serialise on it.
- Same id + same `payloadHash`: replay (work not repeated; `replay` rebuilds the answer from the stored entity).
- Same id + different hash: `409 CONFLICT` (detail `CLIENT_EVENT_ID_REUSED`, or the request's `reusedIdCode`), not stored.
- Business refusals (validation, state, conflict) of a new event are stored `REJECTED` and answered identically later,
  EXCEPT refusals marked `retryable` (an earlier event has not arrived yet, a device clock ahead of the server): those are not
  stored, so the same `clientEventId` can succeed later. Permission denials and unexpected errors are never stored.
- The device time (`occurredAt`) is judged on FIRST delivery only (`assertBelievableEventTime`, the one rule for every writer):
  a late replay of an accepted event is answered from the stored result, never refused as "too old".
- Payloads hold ids and enum values only; a coordinate-looking key throws (coordinates live in `LocationEvent`).
- Hash what the event MEANS (`hashFieldEventContent` in `src/lib/location-rules.ts`), never transport details.
