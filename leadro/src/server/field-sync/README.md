# field-sync

The batch endpoint `POST /api/v1/field-sync` (§8.7, §25.3; `docs/API_REFERENCE.md` "Offline sync"). It orders, gates and reports;
the meaning of each event belongs to the module that owns its type.

Public API (`index.ts`): `processFieldSyncBatch`, `registerFieldSyncHandler(type, handler)`, `registeredFieldSyncTypes`,
`syncBatchSchema`, the result types. Built-in types (registered on import): `job.note | material | attachment | completion | outcome`,
`shift.start | end`, `location.departure | navigation_opened`. A module built later registers its own type (arrival: `job.arrival`...) with
`registerFieldSyncHandler`; a type has exactly one owner (registering twice throws).

Invariants
- A handler builds the same input the REST endpoint takes (the event's `clientEventId` / `occurredAt` win) and calls the module's service, so an
  offline event and an online request share one code path, one permission check and the shared gate (`src/server/field-events`).
- Events are applied by `occurredAt` (stable by client order); each in its own transaction; one failure never aborts the batch.
- Per-event status: ACCEPTED, REPLAYED, REJECTED (remembered verdict), CONFLICT, FORBIDDEN (not remembered, retryable), UNSUPPORTED, FAILED (retryable).
  Unexpected errors are logged and reported without internals.
- `batchId` is stamped on each event's `FieldEvent` row afterwards (only when still empty, so a replay keeps its first batch).
- No permission at the endpoint itself; only an employee can sync (a device belongs to one).
