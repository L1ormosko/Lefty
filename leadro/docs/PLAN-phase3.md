# LEADRO — Implementation Plan: Phase 3 (Field Operations and Recovery) — backend

Spec: `leadro/docs/SPEC.md` (binding). Phase 3 per §27: shift management, arrival verification,
navigation integration, job completion, job outcome reporting, Lead Recovery Engine, follow-up tasks.
Scope decision (product owner, 2026-11-23): UI/UX is deferred to a later phase — this plan delivers
services, APIs, tests and docs only.

## Global Constraints (Phase 1 + Phase 2 constraints still bind)

- Same module/pipeline/scope/projection/audit/i18n/RLS rules as Phase 2 (`docs/PLAN-phase2.md`
  Global Constraints, `docs/CODING_STANDARDS.md`). New tenant tables: FORCE RLS + composite FKs +
  rls.test set update. New migrations only in Task 1.
- Location (§17): event-based only — shift start, arrival, departure, shift end, approved
  verification. No continuous tracking, no polling endpoints. Every location event stores accuracy
  (meters), device-reported time AND server-received time, source (DEVICE_GPS, GEOFENCE, MANUAL,
  MANAGER). GPS is never "proof": arrival verification method is always shown with confidence wording.
  Location history is sensitive (§22.2): its own field set / permission, minimal retention documented.
- Navigation (§8.3): recording "navigation opened" is allowed as an event; it must never change job
  status or count as arrival.
- Offline (§8.7): field events (status, notes, photos metadata, materials, outcome) accept a
  client-generated `clientEventId` (UUID) and `occurredAt`; the server is idempotent per
  (tenant, employee, clientEventId), orders by occurredAt, and reports per-event results for a batch
  sync endpoint. Duplicate submissions are safe (§25.3).
- Money (completion form amounts) = integer minor units + currency; no commission math (Phase 4 blocked).
- Recovery (§9.3–9.7): rule-driven, configurable lost reasons; never offers discounts automatically
  (§9.6); presence status shown only when supported by valid, recent location data (§26.5); confirmed
  recovered revenue kept separate from estimates (§9.7).
- Attachments/photos: no storage provider is configured → store metadata + a `StorageProvider`
  interface with a "not configured" implementation; uploads refused truthfully (no fake storage).

## Task 1: Phase 3 schema
Shift (employee, start/end, status, device id, start/end location event ids, exception), LocationEvent
(employee, shift?, job?, kind, lat/lng, accuracyM, deviceTime, serverTime, source, verification),
ArrivalVerification (job, method TECHNICIAN|GEOFENCE|MANAGER, at, accuracy, verifiedBy, exception reason),
FieldEvent (offline-safe ingestion log: clientEventId unique per tenant+employee, type, payload ids-only,
occurredAt, receivedAt, result), JobCompletionFormDefinition (per JobType, versioned JSON schema of
allowed fields §8.6), JobCompletion (submitted values snapshot + form version), JobMaterialUsage
(material free-text/id placeholder until Phase 4 materials, quantity, unit), JobOutcome (§9.1 outcome,
lost reason, notes, amounts quoted/approved/charged/collected, payment method/status), LostReason
(configurable), RecoveryRule (trigger/conditions/actions JSON, versioned, active, priority, scope),
LeadRecoveryCase (§9.4 fields, status §9.5, priority, presence snapshot), RecoveryAttempt,
FollowUpTask (generic: assignee, due, target type/id, status), JobAttachment metadata.
Permission catalog: shifts.*, location.view (sensitive), recovery.*, follow_ups.*, job_outcomes.*,
completion_forms.configure; templates per §4.4/§4.5. Tests: RLS set, constraints.

## Task 2: Shifts + location events (§8.1, §17)
Start/end shift (idempotent), current shift, shift history, exceptions (GPS disabled, permission
denied, offline → manual with reason), location event ingestion with accuracy + dual timestamps,
manager views scoped, sensitive projection. APIs `/api/v1/shifts`, `/api/v1/location-events`.

## Task 3: Arrival verification + navigation events (§8.3, §8.4, §17.2, §17.4)
Technician confirm arrival (→ job ARRIVED via jobs lifecycle), geofence event ingestion (radius config,
distance computed straight-line, result recorded with accuracy; inside → candidate verification,
outside → exception requiring manager verification), manager verification/override with reason,
"navigation opened" event (no status change). Jobs lifecycle: technician-allowed transitions extended to
EN_ROUTE→ARRIVED→IN_PROGRESS→(COMPLETED|outcome statuses) per Phase 3, via the jobs module.

## Task 4: Field execution + offline sync (§8.5, §8.6, §8.7)
Start/pause work, notes, materials used, additional work requested, customer approval record,
completion form per job type (definitions versioned; submission validated against the version),
attachments metadata via StorageProvider (not configured → refused truthfully), batch sync endpoint
`/api/v1/field-sync` processing an ordered array of client events idempotently with per-event results.

## Task 5: Job outcome reporting (§9.1, §9.2)
Mandatory outcome after each completed visit (job cannot close without one), configurable lost reasons
(tenant admin), reason required for unsuccessful outcomes, outcome → job status mapping via lifecycle,
amounts captured (minor units), events emitted for recovery (job.not_converted) and notifications.

## Task 6: Lead Recovery Engine (§9.3–9.7, §15 safety subset)
Recovery rules (trigger job.not_converted; conditions on outcome/reason/presence/value; actions:
create case, priority, notify Lead Ops scope, create follow-up task, recommend call — never discount);
rules versioned, testable (dry-run endpoint), loop-safe, approval required to activate high-impact rules
(SoD). Cases: statuses §9.5, assignment, attempts, presence status from latest valid location event
(age + accuracy thresholds, "unknown" otherwise), final outcome; recovered work linked to original
customer/lead/job; attribution: confirmed vs estimated kept separate. APIs `/api/v1/lead-recovery/*`.

## Task 7: Follow-up tasks (§5.6, §5.9, §9.3)
Generic follow-up tasks (lead, customer, job, recovery case targets), assignment, due dates, status,
overdue query, notifications (due soon / overdue via a sweep function), scoped APIs.

## Task 8: Phase 3 hardening + MILESTONE-3
Full verification, docs (ERD, PERMISSIONS, API_REFERENCE drift test, ARCHITECTURE), MILESTONE-3.md with
limitations (no storage provider, no maps/geofencing provider — server-side straight-line check on
device-reported coordinates only, no scheduler for sweeps, UI deferred).
