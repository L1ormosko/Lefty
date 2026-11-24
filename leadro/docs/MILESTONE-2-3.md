# Milestone 2+3 report: Phase 2 (operational core) + Phase 3 (field operations, recovery), BACKEND ONLY

Format follows spec §28.7. This is a working backend prototype. **It is not production-ready and makes no security-review, legal-compliance or readiness claim.** No screen, mobile app or provider exists for any feature below.

## 1. Implemented features (by module, `src/server/<module>`)

**Phase 2: operational core**
- `customers`: customers, service addresses, notes, communication preferences, preferred employees, service history, duplicate detection and review; the shared assignment/scope helpers (`teamMembers`, `jobAssignedToWhere`).
- `leads`: intake, lifecycle and status history, ownership/assignment with open-contact-attempt conflict rule, contact attempts, duplicate flags, linking to customers, conversion to a job in one transaction.
- `jobs`: creation (manual and from a lead), the lifecycle machine (`src/lib/job-lifecycle.ts`, tenant can only narrow it), assignment/reassignment with enforced eligibility and audited override, rescheduling, visit numbering, trails and job events.
- `qualifications`: skills, certifications/licenses/equipment/training, verification workflow, job-category permissions, service territories, availability, eligibility inputs.
- `dispatch`: hard eligibility filter, explainable rule-based recommendations, dispatcher approve/modify/reject with recorded overrides, dispatch modes, dispatch picture.

**Phase 3: field operations and recovery**
- `shifts`, `location`: shifts and exceptions, location events with retention, presence helpers; coordinates never leave the module.
- `arrival`: confirm arrival (geofence judgement, never blocks the job), start work, navigation-opened, manager verification of arrivals.
- `field-events`, `field-sync`: the one offline gate (idempotent per `clientEventId`, content hash, single device-time rule) and the batch endpoint `POST /field-sync` with a handler registry (en_route, arrive, start_work, note, material, attachment, completion, outcome, shift start/end, location events, follow_up status/complete/cancel).
- `field-execution`: notes, materials, attachment metadata (storage provider port, not configured), versioned completion forms and submissions.
- `job-outcomes`: visit outcomes, lost reasons, corrections (audited with full previous/new values), the `job.not_converted` domain event.
- `recovery`: versioned rules (approval for high-impact), the engine inside the outcome transaction, dry run, cases, attempts, presence snapshot, recovery summary (confirmed and estimated never added).
- `follow-ups`: tasks about a lead, customer, job or recovery case, assignment, status, overdue/due-soon sweep, per-target access registry.

**Final fix wave (this report's closing work)**: record numbers taken inside the create transaction (pool starvation fixed, 40-way burst test); one job list-access helper so follow-up lists agree with single-record checks for Lead Operations; presence refresh limited to the window after the outcome and to the case job's events; customers of a recovery case open for Lead Operations; arrival needs `jobs.edit`; customer-approval notes and completion only by an assigned employee; `canStillReach` derived from the job machine; one `holdsOutcomeFinancialSet`, `teamMembers`, `assertBelievableEventTime`; follow-up registry on `globalThis` and fail-closed; `follow_up.*` sync handlers; unused notification events removed; job-create audit holds money field names only; documentation brought up to date (`ARCHITECTURE.md`, `PROJECT_STATE.md`, superseded notes marked inline). Details: `DECISIONS.md` "Phase 2+3 final fix wave".

## 2. Changed files

Roughly the 14 new modules above under `src/server`, 121 new route files under `src/app/api/v1` (162 total), the migrations below, `src/lib` pure rule modules (job lifecycle, eligibility, dispatch scoring, arrival/location/shift/outcome/completion/recovery rules), catalog keys in en-US/es-US/he-IL, and the `tests/` tree. Docs: `API_REFERENCE`, `ERD`, `PERMISSIONS`, `AUTHZ`, `ARCHITECTURE`, `DECISIONS`, `PROJECT_STATE`, per-module READMEs, this report.

## 3. Database changes (migrations after Milestone 1, in order)

1. `20261122121345_phase2_operational_core`: customers, addresses, leads, jobs, assignments, qualifications, dispatch, number sequences, operations settings.
2. `20261122140000_phase2_schema_fixes`: corrections found in review of the Phase 2 schema.
3. `20261123100000_phase3_field_operations`: shifts, location events, field events, arrival verification, outcomes, completion forms, field records, recovery rules/cases/attempts/runs, follow-up tasks.

Schema now has 66 models (19 at Milestone 1), FORCE RLS on every tenant-owned table. No migration was added in the fix wave.

## 4. API changes (all under `/api/v1`, reference in `API_REFERENCE.md`)

New groups: `customers`, `leads`, `jobs` (create, read, assign, transition, reschedule, history, outcome, arrive, start-work, navigation-opened, arrivals, notes, materials, attachments, completion), `dispatch`, `qualifications`, `shifts`, `location-events`, `completion-forms`, `job-outcomes`, `lost-reasons`, `lead-recovery` (rules, dry-run, cases, attempts, recover, refresh-presence, summary), `follow-ups`, `field-sync`, `notifications`. Changed in the fix wave: refresh-presence can answer `UNKNOWN` with reason `refresh_window_closed`; sync accepts `follow_up.status|complete|cancel`; a future device time is now retryable on every offline write; `jobs/{id}/arrive` needs `jobs.edit`; customer-approval notes and completion return 403 for non-assigned callers.

## 5. Tests (final run, `leadro/`, real PostgreSQL 16, after the last commit)

| Check | Result |
|---|---|
| `npm test` (Vitest) | **132 files, 1788 tests: 1788 passed, 0 failed, 0 skipped** (480 s) |
| `npm run typecheck` | passed, 0 errors |
| `npm run lint` | passed, 0 problems |
| `npm run i18n:check` | passed |
| `npm run build` | passed (Next.js production build) |
| `npm run test:e2e` (Playwright, Chromium) | **9 passed, 0 failed** (1.5 min); sign-in, access and tenant-isolation flows of Phase 1 screens only |

Fix-wave tests added: concurrent creation burst (customers, leads), job-vs-list agreement for Lead Operations, customer of a case without a lead, presence refresh window and job-only events, arrival without `jobs.edit`, customer approval/completion by a non-assignee, `canStillReach`, follow-up sync events. The MFA replay flake is fixed by pinning the TOTP step. **There is no single end-to-end test of the whole chain** (lead intake -> conversion -> dispatch -> field steps -> outcome -> recovery case -> recovery); each link is tested, and `tests/recovery/routes.test.ts` covers outcome -> case -> recovery over HTTP.

## 6. Known limitations and gaps (do not assume these exist)

- **UI is deferred.** No screen for any Phase 2/3 module and no mobile app; only the Phase 1 admin screens exist. The e2e suite covers those only.
- **No providers**: no storage provider (attachment upload targets answer "not configured"), no geocoding (coordinates exist only when a person supplies them), no email/SMS/push channels (the in-app inbox works), no maps.
- **No scheduler or worker**: the overdue/due-soon sweep, pending-notification delivery and retention purges are functions nobody calls on a schedule; there is no worker list.
- **No unauthenticated integration intake** for leads (webhook/API-key sources); intake is by authenticated users only.
- **Role templates** for Regional Manager, Team Leader, Customer Relations and HR remain provisional, as do the Phase 3 additions (Lead Operations recovery/job/customer grants, technician field grants).
- **Offline wrappers not fully unified (M2, partial)**: the device-time rule is one function, but the two job-scoped shells (`arrival/own-field-write.ts`, `field-execution/access.ts`) and the direct `runFieldEvent` uses in job outcomes and the transition endpoint remain separate.
- **`canStillReach` is broader than the old lists**: jobs still in CREATED/PENDING_ASSIGNMENT/ON_HOLD now count as "can still arrive", so such events are retryable (not stored) rather than stored refusals.
- The jobs module's own list does not apply `recovery_related`; Lead Operations reach a job through its case or a follow-up.
- A cross-job manager queue of pending arrivals does not exist (per-job list only); shift-exception notifications are not built; no merging of duplicate customers; no audit-log API/UI (inherited).
- Money columns are 32-bit integers (`Int`, minor units): amounts above about 21 million major units overflow. Acceptable for the prototype, must be revisited (BigInt) before **Phase 4**.
- **Phase 4 (finance, compensation) is blocked** on an approved compensation spec (§28.4) and the 32-bit money decision above.
- Inherited from Milestone 1: in-memory rate limiting, trigger-only audit immutability, MFA trust-on-first-use, `Tenant`/`Permission` without RLS (see `MILESTONE-1.md` section 6).

## 7. Security implications

- Data access follows scope + record-set rules; denials on a record are 404. Coordinates and device positions are never returned by any API; presence is a derived status only.
- **Presence refresh (ruling)**: only within `presenceMaxAgeMinutes` after the outcome and only from the technician's events for that job; otherwise `refresh_window_closed`.
- **Four "quote" sensitivities** (disclosed in `PERMISSIONS.md`): a lead's base fields hold the quoted amount; a job's base fields show it was quoted though money is the `financial` set; outcome money is the `financial` set; a recovery case carries the quoted value as the case value, visible to every holder of `recovery.view` over the case. The rule dry-run redacts money because it can target outcomes without a case.
- Offline events: idempotent per employee and `clientEventId`; a reused id with other content is 409; the device time is judged once, on first delivery.
- Customer approval and the completion form can only be recorded by an employee assigned to the job; arrival needs the same `jobs.edit` as the status endpoint.
- Audit trails hold ids and field names, never free text or amounts for outcomes, notes and job creation.
- No security review, penetration test or compliance review has been done.

## 8. Open END decisions (for the owner)

1. Should the recovery case value (the quoted amount) stay visible to every case viewer? (ruled yes for now)
2. Presence refresh window and "only the case job's events" (ruled as above; a longer window or live tracking is a product decision).
3. Customer approval/completion limited to the assigned employee (ruled yes; a team-lead override is not built).
4. Lead Operations see the customer of any recovery case (via `lead_related`).
5. Provisional role templates (section 6) and the Lead Operations grant set.
6. Money width (32-bit) and currency handling before Phase 4.
7. Which providers (storage, geocoding, notification channels) and which scheduler/worker to adopt.

## 9. Remaining tasks

UI for Phase 2/3 and the field app; providers and a worker for sweeps/delivery/retention; unauthenticated lead intake; full unification of the offline wrappers; one end-to-end chain test; confirm provisional templates; resolve the open decisions; Phase 4 once the compensation spec is approved; Phase 8 hardening list from Milestone 1.
