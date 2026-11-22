# LEADRO — Implementation Plan: Phase 2 (Operational Core)

Spec: `leadro/docs/SPEC.md` (binding). Phase 2 per §27: customers, leads, lead assignment, job
creation, job lifecycle, dispatch board, technician mobile application, basic notifications.
Dispatch eligibility (§7.3) requires the qualification engine (§10.1), so its core is pulled forward
from Phase 5.

## Global Constraints (in addition to Phase 1 constraints, which still bind)

- Everything in Phase 1 `docs/CODING_STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/API_CONVENTIONS.md`
  binds: modules in `src/server/<module>/` with index.ts-only imports (ESLint enforced), thin routes via
  `defineRoute`, services re-check with `enforceInTx`, lists via `withinScope` + per-row projection,
  writes audited in the same transaction, Zod at boundaries, i18n keys in all three catalogs.
- Every new tenant-owned table: `tenantId`, composite `(ref, tenantId)` FKs, ENABLE + FORCE RLS with the
  `tenant_isolation` policy, update `tests/db/rls.test.ts` expected set.
- Status machines (§6.3, §7.2): statuses are language-neutral enums; allowed transitions live in ONE
  pure module per entity (`src/lib/<entity>-lifecycle.ts`), tenant-configurable only by narrowing (a
  tenant may disable optional transitions, never add invalid ones). Every change writes a
  StatusHistory row (previous, new, actor/system, timestamp, reason).
- No fake integrations (§28.3): no fake maps, SMS, email, push, telephony. Where a provider is needed,
  define an interface + a "not configured" implementation that the UI states truthfully.
  Distances: straight-line (haversine) from stored coordinates, labelled "straight-line estimate", never
  presented as travel time from a provider.
- AI (§28.6): dispatch recommendations are deterministic, rule-based, explainable (every factor and its
  contribution shown), human-approved; overrides recorded. No LLM in Phase 2.
- Performance must not remove access to ordinary work (§7.3, §10.3): no performance factor in
  eligibility; soft factors only for ranking, and only those listed.
- Idempotency for intake and creation endpoints (§20.3); duplicate detection flags, never auto-merges (§6.4).
- Technician experience (§5.10, §8): mobile-first responsive web workspace inside the same Next app
  (React Native wrapper is a pending stack decision — see end-of-project decisions). Large touch targets,
  minimal navigation.

## Task 1: Phase 2 schema + permission catalog

Prisma models + one migration (RLS included): Customer, CustomerAddress (lat/lng optional, decimal),
LeadSource, Lead, LeadAssignment, LeadStatusHistory, LeadInteraction (contact attempts, notes, channel),
DuplicateFlag (lead/customer pairs, reason, resolution), JobType (category, required skills/certs/equipment,
default duration, completion form schema JSON placeholder for Phase 3), Job, JobAssignment, JobStatusHistory,
JobEvent, Skill, Certification (type), EmployeeQualification (skill/cert/license/equipment, number, issuedAt,
expiresAt, verifiedBy), ServiceTerritory (employee ↔ org unit coverage), Availability (employee weekly
windows + exceptions, time zone aware), Notification, NotificationDelivery (channel, attempt, provider
response, failure reason, retry status — §14.3), NotificationPreference. Money fields (quoted amount on
lead/job) as integer minor units + currency.
Permission catalog additions with docs/PERMISSIONS.md: customers.*, leads.*, jobs.*, dispatch.*,
qualifications.*, notifications.* (own), job_types.configure; role templates updated per §4.5 matrix rows
Customers / Leads / Dispatch / Jobs (Dispatcher full scope dispatch; Lead Ops full lead scope; Technician
assigned jobs only; Customer Relations customers in scope), sensitive field set `customers.billing`.
Tests: RLS coverage, catalog/template tests updated.

## Task 2: Customers module (§6.1, §6.4, §5.9)
Service + `/api/v1/customers/*`: CRUD (archive not delete), addresses, communication preferences,
preferred language, notes, search (name/phone/email, normalized E.164 phone), history view (leads/jobs ids),
duplicate detection on create/update (configurable matchers: phone, email, normalized address) → DuplicateFlag,
manual resolution (mark not-duplicate / link), never auto-merge. Scope: customers visible via ASSIGNED
(lead/job relation) and ORG_UNIT (service-area branch) scopes. Tests incl. isolation + projection.

## Task 3: Qualification engine (§10.1, §7.3 hard requirements)
Skills, certifications, licenses, equipment, job-category permissions, territories, availability windows.
Service `isEligible(employee, job)` → { eligible, failures[] } with explicit reasons; expiry-aware;
`/api/v1/qualifications/*` + HR screens later. Certification-expiring query (for notifications).
No performance data anywhere in eligibility. Tests.

## Task 4: Notifications engine (§14)
In-app channel implemented end-to-end; email/SMS/push behind a `NotificationChannel` interface with a
"not configured" implementation recorded as delivery status NOT_CONFIGURED (truthful). Event API
`notify(tx, event)` with idempotency key; delivery tracking; failures never roll back the business
transaction (write notification in tx, deliver after commit). Preferences (non-critical opt-out only).
`/api/v1/notifications` (own list, mark read). Tests.

## Task 5: Leads module (§6.2–6.4, §5.6)
Intake (manual, API with Idempotency-Key + source), lifecycle machine (§6.3) with validated transitions +
history, assignment/reassignment to lead-ops employees (conflict rule §25.1: reassignment while another
employee has an open contact attempt requires explicit confirmation + reason), interactions/contact
attempts, follow-up due dates, duplicate flagging (reuses customers matcher), conversion → creates Job via
jobs service in one transaction. Notifications: lead assigned. `/api/v1/leads/*`. Tests incl. §25.1 scenarios.

## Task 6: Jobs module (§7.1–7.2)
Creation (from lead conversion, manual), lifecycle machine (§7.2 default + exceptional statuses), tenant
narrowing config, assignment/reassignment (employee or team), reschedule, priority, appointment window
validation (duration vs window §25.2 → warning), history, events. Notifications: job assigned/reassigned.
Technician view of own assigned jobs (ASSIGNED scope). `/api/v1/jobs/*`. Tests incl. invalid transitions.

## Task 7: Dispatch engine (§7.3–7.5, §5.5, §25.2)
Eligibility = qualification engine hard filters + availability + territory + active employee.
Recommendation: rule-based ranking over soft factors (straight-line distance, current workload, experience
with job type, customer preference) with per-factor explanation and conflicts; dispatcher approve / reject /
modify; manual override recorded with reason; "no eligible technician" path keeps the job pending with the
blocking reasons. Modes: MANUAL and AI_ASSISTED (rule-based, human approval) implemented; RULE_BASED_AUTO
and OPTIMIZATION are configuration values that are refused as "not available in this phase".
`/api/v1/dispatch/*`. Tests.

## Task 8: Operations UI (§5.5, §5.6, §5.9)
Dispatcher board (job list + filters, availability panel, recommendation panel with explanations,
job drawer, assign/reassign/reschedule; map panel truthfully "map provider not configured" with address
list), Lead Operations workspace (dashboard counts from real data, queues: new/unassigned/assigned/contact
queue, lead detail with interactions), Customer Relations (directory, customer detail, history), notification
center in TopNav. Navigation items gated as in Phase 1 (scope-aware). EN/ES/HE.

## Task 9: Technician mobile workspace (§5.10, §8.2–8.3)
Mobile-first `/tech` area: Home (today's/next job), My Jobs, Job detail (customer, address, window,
instructions, equipment, status), navigation deep links (Google Maps + Waze URLs, copy address — opening is
NOT arrival, §8.3), status updates allowed for technicians (EN_ROUTE, and the remaining field statuses are
Phase 3), Schedule (assigned jobs by day), Profile + language. Large touch targets, RTL. Tests + e2e spec.

## Task 10: Phase 2 hardening + MILESTONE-2
Full verification, e2e specs for dispatch and lead flows, docs (ARCHITECTURE, PERMISSIONS, API_REFERENCE
drift test green, ERD), `docs/MILESTONE-2.md` per §28.7, limitations stated.
