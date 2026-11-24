# job-outcomes

The outcome of every customer visit and the tenant's lost reasons (§9.1, §9.2). A job cannot close without the
outcome of its current visit. Routes: `/api/v1/jobs/{id}/outcome(s)`, `/api/v1/job-outcomes/**`, `/api/v1/lost-reasons/**`
(`docs/API_REFERENCE.md` "Job outcomes and lost reasons"). Pure rules: `src/lib/job-outcome-rules.ts`.

Public API (`index.ts`):
- `recordJobOutcome(actor, ctx, jobId, input)`: the API entry. Offline envelope: `clientEventId` + `occurredAt`; the shared gate (`src/server/field-events`, type `job.outcome`)
  makes it idempotent per (tenant, employee, clientEventId): same content = replay, different = 409 `field_event.payload_mismatch`.
- **`recordOutcomeInTx(tx, actor, audit, jobId, input)`**: the domain work inside the caller's transaction, for the offline sync
  (Task 4) and the gate's `apply` step. Locks the job, checks `job_outcomes.create` over it, validates, stores the
  outcome, applies the job status through jobs' `changeJobStatus`, writes events + audit, publishes the domain event, notifies.
- `correctJobOutcome` (`job_outcomes.edit`; audits full previous/new values), `getOutcomeCorrections` (history; edit + financial set), `getJobOutcome`, `listJobOutcomes` (scope through the job).
- Retroactive outcome: a job already past its visit (COMPLETED, FAILED, REQUIRES_RETURN_VISIT, AWAITING_REVIEW, CUSTOMER_UNAVAILABLE) takes one from a create OR edit holder with no status change, so it can close.
- Amounts, currency and payment are the `financial` field set (`JOB_OUTCOME_FIELD_MAP`); the currency is always the job's.
- Lost reasons: `listLostReasons`, `getLostReason`, `createLostReason`, `updateLostReason` (`job_outcomes.configure`, tenant-wide).
- **Recovery contract** (Task 6): `onJobOutcomeRecorded(name, handler)` subscribes to `OutcomeRecordedEvent` (ids, enums, flags: outcome,
  `lostReasonId`, `lostReasonRecoverable`, `notConverted`, `customerRequestedFollowUp`, `jobStatus`); handlers run INSIDE the recording
  transaction (a throwing handler rolls the outcome back). The same facts are in the job's event log as `job.outcome_recorded` and, for
  NOT_SOLD / WORK_NOT_POSSIBLE, `job.not_converted`. Also `registerJobOutcomeNotificationTarget`, `outcomeResourceRef`.

Invariants:
- One outcome per `(job, visitNumber)` (DB unique); `visitNumber = Job.currentVisitNumber`, advanced by the jobs lifecycle.
- NOT_SOLD and WORK_NOT_POSSIBLE need an active lost reason that lists the outcome; SOLD has none; approved / charged / collected amounts and
  a payment belong to SOLD only; money is integer minor units; no commission math.
- Each outcome maps to ONE direct lifecycle edge (`OUTCOME_STATUS_RULES`; a test pins it), so recording never skips a rule; a tenant that switched
  that edge off gets a 409 and nothing is written.
- Events, audit and notification params hold ids / enums / field names, never notes or amounts. Lost reasons are retired (`active: false`), never deleted.
- The outcome type is never corrected afterwards (the job status already followed it).
