# KPI definitions

<!-- GENERATED from src/lib/kpi-catalog.ts by `npm run kpi:docs`. Do not edit by hand. -->

Every KPI a LEADRO dashboard or report shows (spec 13.4): its formal definition, calculation formula, source records, time
period, applicable organizational scope, responsible data owner (a role; configurable per tenant later), unit and the access it
requires. Dashboards reference KPIs by key; the same key never means two things, a variant has its own key.

Conventions: periods are tenant-local dates in the tenant's time zone (weeks start Monday). COHORT_IN_PERIOD KPIs measure the
records created in the period as they are now (a cohort's rate can still change later); EVENT_IN_PERIOD KPIs count the anchor
event in the period; SNAPSHOT KPIs are the state at request time. Grouping rolls a record's attributed unit up the current org
tree. Money is integer minor units per currency, never summed across currencies. DURATION is the median in seconds. PER_HOUR
divides numerator records by the hours of a time base. Ledger KPIs count a REVERSAL under the type it reverses.

## Operational (spec 13.2)

### `lead_response_time`

- **Status**: ACTIVE
- **Definition**: How long a new lead waits for the first outbound contact attempt.
- **Formula**: median(first CONTACT_ATTEMPT interaction.occurredAt - Lead.createdAt) over leads created in the period that have a contact attempt; DUPLICATE leads excluded.
- **Unit**: DURATION
- **Source records**: `Lead`, `LeadInteraction`
- **Time period**: COHORT_IN_PERIOD, anchored on Lead.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the lead (Lead.orgUnitId); leads without one count only in tenant-wide figures.
- **Data owner**: `LEAD_OPERATIONS_MANAGER`
- **Required access**: any of `analytics_operational.view`, `analytics_lead.view`; field set `base`
- **Label**: `KPI.LEAD_RESPONSE_TIME`

### `time_to_assignment`

- **Status**: ACTIVE
- **Definition**: How long a new job waits for its first lead technician assignment.
- **Formula**: median(first LEAD JobAssignment.assignedAt - Job.createdAt) over jobs created in the period that have been assigned.
- **Unit**: DURATION
- **Source records**: `Job`, `JobAssignment`
- **Time period**: COHORT_IN_PERIOD, anchored on Job.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `DISPATCHER`
- **Required access**: any of `analytics_operational.view`; field set `base`; sets `dispatch_kpis`
- **Label**: `KPI.TIME_TO_ASSIGNMENT`

### `time_to_arrival`

- **Status**: ACTIVE
- **Definition**: How long it takes from the first lead technician assignment to the first recorded arrival at the job.
- **Formula**: median(first ArrivalVerification.arrivedAt (not MANAGER_REJECTED) - first LEAD JobAssignment.assignedAt) over jobs created in the period with both.
- **Unit**: DURATION
- **Source records**: `Job`, `JobAssignment`, `ArrivalVerification`
- **Time period**: COHORT_IN_PERIOD, anchored on Job.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `DISPATCHER`
- **Required access**: any of `analytics_operational.view`; field set `base`; sets `dispatch_kpis`
- **Label**: `KPI.TIME_TO_ARRIVAL`

### `job_duration`

- **Status**: ACTIVE
- **Definition**: How long work on a job takes, from start to completion.
- **Formula**: median(Job.completedAt - Job.startedAt) over jobs completed in the period that have a start time.
- **Unit**: DURATION
- **Source records**: `Job`
- **Time period**: EVENT_IN_PERIOD, anchored on Job.completedAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `COO`
- **Required access**: any of `analytics_operational.view`; field set `base`
- **Label**: `KPI.JOB_DURATION`

### `jobs_per_employee`

- **Status**: ACTIVE
- **Definition**: Completed jobs per technician who led at least one of them. A group figure only: never listed or ranked per employee.
- **Formula**: count(jobs completed in the period with a LEAD assignee) / count(distinct LEAD assignees of those jobs), per group.
- **Unit**: RATIO
- **Source records**: `Job`, `JobAssignment`, `OrganizationalAssignment`
- **Time period**: EVENT_IN_PERIOD, anchored on Job.completedAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The unit of the lead technician's PRIMARY OrganizationalAssignment effective at Job.completedAt (spec 3), never today's; jobs whose technician had no placement then are left out. The job itself must be in the viewer's scope too.
- **Data owner**: `COO`
- **Required access**: any of `analytics_operational.view`; field set `base`
- **Label**: `KPI.JOBS_PER_EMPLOYEE`

### `completed_jobs`

- **Status**: ACTIVE
- **Definition**: Jobs completed in the period.
- **Formula**: count(Job where completedAt in the period).
- **Unit**: COUNT
- **Source records**: `Job`
- **Time period**: EVENT_IN_PERIOD, anchored on Job.completedAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `COO`
- **Required access**: any of `analytics_operational.view`; field set `base`
- **Label**: `KPI.COMPLETED_JOBS`

### `revisit_rate`

- **Status**: ACTIVE
- **Definition**: Share of completed jobs that needed more than one visit.
- **Formula**: count(jobs created in the period, completed, with currentVisitNumber > 1) / count(jobs created in the period, completed).
- **Unit**: RATE
- **Source records**: `Job`
- **Time period**: COHORT_IN_PERIOD, anchored on Job.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `COO`
- **Required access**: any of `analytics_operational.view`; field set `base`
- **Label**: `KPI.REVISIT_RATE`

### `cancellation_rate`

- **Status**: ACTIVE
- **Definition**: Share of jobs created in the period that are cancelled.
- **Formula**: count(jobs created in the period with status CANCELLED) / count(jobs created in the period).
- **Unit**: RATE
- **Source records**: `Job`
- **Time period**: COHORT_IN_PERIOD, anchored on Job.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `COO`
- **Required access**: any of `analytics_operational.view`; field set `base`
- **Label**: `KPI.CANCELLATION_RATE`

### `unassigned_jobs`

- **Status**: ACTIVE
- **Definition**: Open jobs that have no active lead technician right now.
- **Formula**: count(Job with status CREATED, PENDING_ASSIGNMENT or RESCHEDULED, not archived, and no ACTIVE LEAD JobAssignment) at request time.
- **Unit**: COUNT
- **Source records**: `Job`, `JobAssignment`
- **Time period**: SNAPSHOT, anchored on request time
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `DISPATCHER`
- **Required access**: any of `analytics_operational.view`; field set `base`; sets `dispatch_kpis`
- **Label**: `KPI.UNASSIGNED_JOBS`

### `dispatch_recommendation_acceptance_rate`

- **Status**: ACTIVE
- **Definition**: Dispatch efficiency (1 of 2): share of jobs whose first lead assignment took the dispatch recommendation as proposed.
- **Formula**: count(first LEAD JobAssignment.method = RECOMMENDATION_APPROVED) / count(jobs with a first LEAD assignment), over jobs created in the period.
- **Unit**: RATE
- **Source records**: `Job`, `JobAssignment`
- **Time period**: COHORT_IN_PERIOD, anchored on Job.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `DISPATCHER`
- **Required access**: any of `analytics_operational.view`; field set `base`; sets `dispatch_kpis`
- **Label**: `KPI.DISPATCH_RECOMMENDATION_ACCEPTANCE_RATE`

### `dispatch_decision_latency`

- **Status**: ACTIVE
- **Definition**: Dispatch efficiency (2 of 2): how long a dispatch recommendation waits for the dispatcher's decision.
- **Formula**: median(DispatchRecommendation.decidedAt - generatedAt) over decided recommendations of jobs created in the period.
- **Unit**: DURATION
- **Source records**: `Job`, `DispatchRecommendation`
- **Time period**: COHORT_IN_PERIOD, anchored on Job.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `DISPATCHER`
- **Required access**: any of `analytics_operational.view`; field set `base`; sets `dispatch_kpis`
- **Label**: `KPI.DISPATCH_DECISION_LATENCY`

## Lead and recovery (spec 13.1, 9.7)

### `lead_volume_by_source`

- **Status**: ACTIVE
- **Definition**: New leads per lead source.
- **Formula**: count(Lead created in the period, status not DUPLICATE), per LeadSource (null = no source).
- **Unit**: COUNT, broken down by LEAD_SOURCE
- **Source records**: `Lead`, `LeadSource`
- **Time period**: COHORT_IN_PERIOD, anchored on Lead.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the lead (Lead.orgUnitId); leads without one count only in tenant-wide figures.
- **Data owner**: `LEAD_OPERATIONS_MANAGER`
- **Required access**: any of `analytics_lead.view`, `analytics_executive.view`; field set `base`
- **Label**: `KPI.LEAD_VOLUME_BY_SOURCE`

### `lead_conversion_rate_by_source`

- **Status**: ACTIVE
- **Definition**: Share of new leads that were converted into a job, per lead source.
- **Formula**: count(leads created in the period with status CONVERTED) / count(leads created in the period, status not DUPLICATE), per LeadSource.
- **Unit**: RATE, broken down by LEAD_SOURCE
- **Source records**: `Lead`, `LeadSource`
- **Time period**: COHORT_IN_PERIOD, anchored on Lead.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the lead (Lead.orgUnitId); leads without one count only in tenant-wide figures.
- **Data owner**: `LEAD_OPERATIONS_MANAGER`
- **Required access**: any of `analytics_lead.view`, `analytics_executive.view`; field set `base`
- **Label**: `KPI.LEAD_CONVERSION_RATE_BY_SOURCE`

### `recovery_rate`

- **Status**: ACTIVE
- **Definition**: Share of decided recovery cases that were recovered.
- **Formula**: count(cases with recoveredAt) / count(cases with status RECOVERED, NOT_RECOVERED or CLOSED), over cases whose lost visit (outcomeAt) is in the period.
- **Unit**: RATE
- **Source records**: `LeadRecoveryCase`
- **Time period**: COHORT_IN_PERIOD, anchored on LeadRecoveryCase.outcomeAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the recovery case (LeadRecoveryCase.orgUnitId).
- **Data owner**: `LEAD_OPERATIONS_MANAGER`
- **Required access**: any of `analytics_lead.view`, `analytics_executive.view`; field set `base`
- **Label**: `KPI.RECOVERY_RATE`

### `recovery_confirmed_revenue`

- **Status**: ACTIVE
- **Definition**: CONFIRMED revenue of recovered cases (amounts recorded when the recovery was confirmed). Never mixed with estimates (spec 9.7).
- **Formula**: sum(recoveredAmountMinor) per currency over cases with recoveredAt and status RECOVERED or CLOSED whose lost visit (outcomeAt) is in the period.
- **Unit**: MONEY
- **Source records**: `LeadRecoveryCase`
- **Time period**: COHORT_IN_PERIOD, anchored on LeadRecoveryCase.outcomeAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the recovery case (LeadRecoveryCase.orgUnitId).
- **Data owner**: `LEAD_OPERATIONS_MANAGER`
- **Required access**: any of `analytics_lead.view`, `analytics_executive.view`; field set `base`
- **Label**: `KPI.RECOVERY_CONFIRMED_REVENUE`

### `recovery_estimated_value`

- **Status**: ACTIVE
- **Definition**: ESTIMATED value still open in recovery (the employee-entered or quoted estimate). An estimate, never revenue (spec 9.7).
- **Formula**: sum(estimatedValueMinor) per currency over open cases (status not RECOVERED, NOT_RECOVERED or CLOSED) whose lost visit (outcomeAt) is in the period.
- **Unit**: MONEY (an ESTIMATE, labelled as such)
- **Source records**: `LeadRecoveryCase`
- **Time period**: COHORT_IN_PERIOD, anchored on LeadRecoveryCase.outcomeAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the recovery case (LeadRecoveryCase.orgUnitId).
- **Data owner**: `LEAD_OPERATIONS_MANAGER`
- **Required access**: any of `analytics_lead.view`, `analytics_executive.view`; field set `base`
- **Label**: `KPI.RECOVERY_ESTIMATED_VALUE`

## Financial (spec 13.1, 13.3)

### `sold_revenue`

- **Status**: ACTIVE
- **Definition**: Amounts customers APPROVED on visits reported as sold (the technician's report, before finance confirms a charge). Not ledger revenue: the ledger is charged revenue.
- **Formula**: sum(JobOutcome.approvedAmountMinor) per currency over outcomes SOLD with an approved amount whose visit (occurredAt) is in the period; a corrected outcome counts with its current amount.
- **Unit**: MONEY
- **Source records**: `JobOutcome`, `Job`
- **Time period**: EVENT_IN_PERIOD, anchored on JobOutcome.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`; AND `job_outcomes.view` with field set `financial` (scopes intersected)
- **Label**: `KPI.SOLD_REVENUE`

### `charged_revenue`

- **Status**: ACTIVE
- **Definition**: Revenue charged to customers (spec 13.1 "Revenue"), as finance posted it.
- **Formula**: sum(CHARGE) + sum(REVERSAL of a CHARGE) per currency over LedgerEntry with occurredAt in the period.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: EVENT_IN_PERIOD, anchored on LedgerEntry.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.CHARGED_REVENUE`

### `collected_revenue`

- **Status**: ACTIVE
- **Definition**: Payments received (gross collections; refunds and chargebacks are their own KPIs).
- **Formula**: sum(PAYMENT) + sum(REVERSAL of a PAYMENT, i.e. voids) per currency over LedgerEntry with occurredAt in the period.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: EVENT_IN_PERIOD, anchored on LedgerEntry.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.COLLECTED_REVENUE`

### `outstanding_amount`

- **Status**: ACTIVE
- **Definition**: What customers still owe right now: billed (charges and adjustments) minus net collected (payments minus refunds and chargebacks). Negative = customers in credit.
- **Formula**: sum over ALL ledger entries at request time of: CHARGE + ADJUSTMENT - PAYMENT - REFUND - CHARGEBACK (signed amounts, reversals under the type they reverse), per currency; MATERIAL_COST excluded.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: SNAPSHOT, anchored on request time
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.OUTSTANDING_AMOUNT`

### `material_costs`

- **Status**: ACTIVE
- **Definition**: Cost of materials used on jobs, as costed into the ledger (a positive amount).
- **Formula**: -(sum(MATERIAL_COST) + sum(REVERSAL of a MATERIAL_COST)) per currency over LedgerEntry with occurredAt in the period.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: EVENT_IN_PERIOD, anchored on LedgerEntry.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`; AND `materials.view` with field set `cost` (scopes intersected)
- **Label**: `KPI.MATERIAL_COSTS`

### `direct_costs`

- **Status**: ACTIVE
- **Definition**: Direct costs of jobs. Only material costs are modelled today (labour, subcontractors and other direct costs are not), so it equals material_costs until they are; a separate key because it will not stay equal.
- **Formula**: -(sum(MATERIAL_COST) + sum(REVERSAL of a MATERIAL_COST)); no other direct cost type exists yet per currency over LedgerEntry with occurredAt in the period.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: EVENT_IN_PERIOD, anchored on LedgerEntry.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`; AND `materials.view` with field set `cost` (scopes intersected)
- **Label**: `KPI.DIRECT_COSTS`

### `gross_profit`

- **Status**: ACTIVE
- **Definition**: Charged revenue minus direct costs, per currency (adjustments, refunds and chargebacks are not part of it).
- **Formula**: (sum(CHARGE) + REVERSALs of CHARGEs) + (sum(MATERIAL_COST) + REVERSALs of MATERIAL_COSTs); MATERIAL_COST amounts are negative per currency over LedgerEntry with occurredAt in the period.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: EVENT_IN_PERIOD, anchored on LedgerEntry.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`; AND `materials.view` with field set `cost` (scopes intersected)
- **Label**: `KPI.GROSS_PROFIT`

### `refunds`

- **Status**: ACTIVE
- **Definition**: Money paid back to customers (a positive amount).
- **Formula**: -(sum(REFUND) + sum(REVERSAL of a REFUND)) per currency over LedgerEntry with occurredAt in the period.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: EVENT_IN_PERIOD, anchored on LedgerEntry.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.REFUNDS`

### `adjustments`

- **Status**: ACTIVE
- **Definition**: Net posted (approved) adjustments: positive = customers owe more, negative = credits.
- **Formula**: sum(ADJUSTMENT) + sum(REVERSAL of an ADJUSTMENT), signed per currency over LedgerEntry with occurredAt in the period.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: EVENT_IN_PERIOD, anchored on LedgerEntry.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.ADJUSTMENTS`

### `chargebacks`

- **Status**: ACTIVE
- **Definition**: Money taken back by card networks, net of chargebacks won (a positive amount).
- **Formula**: -(sum(CHARGEBACK) + sum(REVERSAL of a CHARGEBACK, i.e. won disputes)) per currency over LedgerEntry with occurredAt in the period.
- **Unit**: MONEY
- **Source records**: `LedgerEntry`
- **Time period**: EVENT_IN_PERIOD, anchored on LedgerEntry.occurredAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the ledger entry (LedgerEntry.orgUnitId).
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.CHARGEBACKS`

### `reconciliation_exceptions_open`

- **Status**: ACTIVE
- **Definition**: Reconciliation exceptions still waiting for a person (open or assigned).
- **Formula**: count(ReconciliationException with status OPEN or ASSIGNED) at request time.
- **Unit**: COUNT
- **Source records**: `ReconciliationException`
- **Time period**: SNAPSHOT, anchored on request time
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the exception (ReconciliationException.orgUnitId); exceptions without one count only in tenant-wide figures.
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.RECONCILIATION_EXCEPTIONS_OPEN`

### `reconciliation_exceptions_resolved`

- **Status**: ACTIVE
- **Definition**: Reconciliation exceptions resolved in the period.
- **Formula**: count(ReconciliationException with status RESOLVED and resolvedAt in the period).
- **Unit**: COUNT
- **Source records**: `ReconciliationException`
- **Time period**: EVENT_IN_PERIOD, anchored on ReconciliationException.resolvedAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the exception (ReconciliationException.orgUnitId); exceptions without one count only in tenant-wide figures.
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.RECONCILIATION_EXCEPTIONS_RESOLVED`

### `compensation_expense`

- **Status**: BLOCKED_ON_SPEC (The compensation model is not specified (spec 28.4); no number is ever invented for it.)
- **Definition**: Employee compensation expense.
- **Formula**: Not defined until the compensation spec exists.
- **Unit**: MONEY
- **Source records**: none (not defined)
- **Time period**: EVENT_IN_PERIOD, anchored on not defined
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: Not defined until the compensation spec exists.
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.COMPENSATION_EXPENSE`

### `commission_expense`

- **Status**: BLOCKED_ON_SPEC (The compensation model is not specified (spec 28.4); no number is ever invented for it.)
- **Definition**: Commission expense.
- **Formula**: Not defined until the compensation spec exists.
- **Unit**: MONEY
- **Source records**: none (not defined)
- **Time period**: EVENT_IN_PERIOD, anchored on not defined
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: Not defined until the compensation spec exists.
- **Data owner**: `FINANCE_DIRECTOR`
- **Required access**: any of `financial_reports.view`; field set `base`
- **Label**: `KPI.COMMISSION_EXPENSE`

## Executive (spec 13.1)

### `job_volume`

- **Status**: ACTIVE
- **Definition**: Jobs created in the period.
- **Formula**: count(Job where createdAt in the period).
- **Unit**: COUNT
- **Source records**: `Job`
- **Time period**: COHORT_IN_PERIOD, anchored on Job.createdAt
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The org unit snapshotted on the job (Job.orgUnitId).
- **Data owner**: `COO`
- **Required access**: any of `analytics_executive.view`, `analytics_operational.view`; field set `base`
- **Label**: `KPI.JOB_VOLUME`

### `employee_productivity`

- **Status**: ACTIVE
- **Definition**: Completed jobs per RECORDED shift hour (no shift schedule is modelled, so the time base is the shifts employees actually clocked). A group figure for development use only: never listed or ranked per employee.
- **Formula**: count(jobs completed in the period with a LEAD assignee) / sum(endedAt - startedAt of ENDED shifts started in the period, in hours), per group. A shift counts wholly in the bucket it started in.
- **Unit**: PER_HOUR
- **Source records**: `Job`, `JobAssignment`, `Shift`, `OrganizationalAssignment`
- **Time period**: EVENT_IN_PERIOD, anchored on Job.completedAt (jobs) and Shift.startedAt (hours)
- **Organizational scope**: grouped by TENANT, STATE, REGION, CITY, BRANCH, inside the viewer's scope
- **Attribution**: The unit of the employee's PRIMARY OrganizationalAssignment effective at the event (spec 3): at Job.completedAt for the lead technician's job, at Shift.startedAt for the shift. The job or shift must be in the viewer's scope, and so must the attributed unit; otherwise the record is left out.
- **Data owner**: `COO`
- **Required access**: any of `analytics_executive.view`, `analytics_operational.view`; field set `base`
- **Label**: `KPI.EMPLOYEE_PRODUCTIVITY`
