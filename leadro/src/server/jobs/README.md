# jobs

Jobs: creation (by hand and from a converted lead), the lifecycle machine with tenant narrowing, manual
assignment / reassignment (employee or team) with ENFORCED eligibility, rescheduling, priority, trails and the
technician's own-jobs view (§7.1-7.2, §25.2). Routes: `/api/v1/jobs/**` (`docs/API_REFERENCE.md` "Jobs").
The pure status machine is `src/lib/job-lifecycle.ts` (the only place that lists transitions).

Public API (`index.ts`):
- Records: `createJob`, `getJob`, `listJobs`, `listMyJobs` (technician view), `updateJob`.
- **`createJobFromLead(tx, actor, { leadId, customerId, serviceAddressId, jobTypeId, description?, priority?, appointmentWindow? }, ctx?)`**:
  for the leads module, inside ITS conversion transaction. Returns `{ id, number, created, warnings }`; idempotent per lead
  (`created: false` returns the existing job). Authorization is the caller's (the lead service checked the conversion); it does
  not require `jobs.create`. It refuses an archived customer, an address that is not the customer's, an inactive job type.
- Lifecycle: `transitionJob`, `assignJob` (assign AND reassign), `unassignJob`, `rescheduleJob`. Trails: `listJobStatusHistory`,
  `listJobEvents`, `listJobAssignments`. Config: `getJobWorkflowSettings`, `updateJobWorkflowSettings`, `loadDisabledTransitions`.
- Contracts: `getJobEligibilityInputs(tx, tenantId, jobId)` (what the qualification engine needs; the job's own requirement
  rows, snapshotted from the job type at creation), `assignedEmployeeIdsByJob`, `jobResourceRef` (route resolver),
  `teamMembers`, `registerJobNotificationTarget` (called at load: notification links to "job" use `jobs.view`).

Invariants:
- A job is born PENDING_ASSIGNMENT (history: null > CREATED by the user, CREATED > PENDING_ASSIGNMENT by the system).
  Every status change goes through `changeJobStatus` (status.ts): edge allowed by the machine, not switched off by the tenant,
  guards (assignee for ASSIGNED+, slot for SCHEDULED, review rule at COMPLETED), reason where required; then history + event + audit.
- Tenants only NARROW: `OperationsSettings.disabledJobTransitions` may name optional "FROM>TO" edges; anything else is refused on
  write and ignored on read. Every open status still reaches CLOSED through core edges (tested).
- Assignment enforces hard eligibility (qualification engine). Override = `jobs.approve` holder + reason, recorded as method
  OVERRIDE, a `dispatch.override` event and audit; employment failures can never be overridden. Assignments are ENDED, never
  deleted; CLOSED / CANCELLED / unassign end them (ASSIGNED access stops). Team assignments expand to current members.
- Every update calls `assertWritableFields` (Technician: `status`, `statusReason`, `instructions` only; money needs `financial`).
  Execution-only grants may move a job only to EN_ROUTE in Phase 2 (arrival/start/completion are Phase 3).
- Row lock (`FOR UPDATE`) on the job for status / assignment / schedule changes. Money is audited by field name only.
- Conflicts are shown, not blocking (§25.2): `warnings` on writes (`DURATION_EXCEEDS_WINDOW`, `SLOT_SHORTER_THAN_DURATION`,
  `ASSIGNEE_ELIGIBILITY_CONFLICT`). New work for an archived customer is refused.
- ASSIGNED derivation: `loadJobAccessFacts` (per job) and `jobAssignedToWhere` in `@/server/customers` (query form) are the same
  rule; `tests/jobs/access.test.ts` pins that they agree. Customers' `assignedEmployeeIdsByCustomer` is the customer-level union.
- Notifications (in the transaction, delivered after commit): `job.assigned` and `job.rescheduled` link to the job;
  `job.reassigned` (also on unassign) and `job.cancelled` carry the number only, because their recipients just lost access.
- Phase 3 (outcomes): `changeJobStatus` refuses CLOSED until the current visit (`Job.currentVisitNumber`) has a `JobOutcome` (409, detail code
  `job.outcome_required`) and advances `currentVisitNumber` when a job whose current visit has an outcome goes EN_ROUTE / ARRIVED / IN_PROGRESS (not from
  AWAITING_REVIEW: that is rework of the same visit). `field-port.ts` (`changeJobStatus`, `loadJobForChange`,
  `recordJobEvent`) is what field-execution modules use; the `job-outcomes` module applies a visit outcome's status change through it
  (outcome > status mapping: `src/lib/job-outcome-rules.ts`). Technicians do not call `transition` for these steps.
