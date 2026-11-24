# arrival

The technician's field steps on a job and the verification of arrival (§8.3, §8.4, §17.2, §17.4). Routes:
`/api/v1/jobs/{id}/(arrive|start-work|navigation-opened|arrivals)` (`docs/API_REFERENCE.md` "Arrival and field steps").
Pure rules: `src/lib/arrival-rules.ts` (distance and verdict) and the technician steps in `src/lib/job-lifecycle.ts`.

Public API (`index.ts`):
- `confirmArrival(actor, ctx, jobId, input)`: EN_ROUTE > ARRIVED through jobs' `changeJobStatus`. Compares the device position with the service
  address (straight-line haversine vs `CustomerAddress.geofenceRadiusM ?? OperationsSettings.arrivalGeofenceRadiusM`), stores a `LocationEvent`
  (kind ARRIVAL, with accuracy, distance, radius, verdict) and an `ArrivalVerification`. Inside + accurate enough = `RECORDED` (a candidate, never
  proof); outside / vague / no position / address without coordinates = `PENDING_MANAGER_REVIEW` + exception, and managers with `location.approve` are notified.
- `startWork(actor, ctx, jobId, input)`: ARRIVED > IN_PROGRESS, stamps `startedAt` (device time, never before the arrival). Blocked after a manager rejected the arrival.
- `recordNavigationOpened`: the location module's technician flow; never changes the job, never an arrival.
- `verifyArrival` (`location.approve` over the job; reason mandatory; once; not your own arrival): VERIFIED adds a VERIFICATION location event by the manager; REJECTED leaves the job status alone.
- `listJobArrivals` (`location.view` over the job).

Invariants:
- A technician reaches ARRIVED and IN_PROGRESS ONLY through these endpoints (`TECHNICIAN_TARGET_STATUSES` of the plain transition stays EN_ROUTE), so arrival cannot skip the position check.
- Responses carry distance, accuracy, radius, codes and a `confidence` code, never coordinates; audit values and job events carry none either.
- Offline: `clientEventId` + `occurredAt` through `runFieldEvent` (location); replay answers from the first delivery, other content under the same id is 409.
- Technician access: the job must be assigned to the caller, else 404. The shared shell is `own-field-write.ts`.
