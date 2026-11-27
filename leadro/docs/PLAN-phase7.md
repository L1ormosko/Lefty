# LEADRO — Implementation Plan: Phase 7 (Integrations and Automation) — backend

Spec: `leadro/docs/SPEC.md` (binding), especially Part 15 (§15.1–15.2), Part 18 (§18.1–18.3), Part 14
(channels, reliability), §2 (background job queues, managed queue or job processor), §11.9 (payroll
boundary), §11.x "exact accounting treatment must be configurable and reviewed", §26 scenarios on duplicate
webhooks, §28.3 (no fake integrations), §28.4 (compensation blocked). Scope decision: UI deferred (owner).

## Global Constraints (Phase 1–6 constraints still bind)

- No fake providers (§28.3): every provider category (maps, navigation, SMS, email, push, telephony, payment,
  payroll, accounting, marketing lead sources, external CRM) is an interface with a "not configured"
  implementation that reports its status truthfully. Nothing pretends to send, charge or sync.
- Secrets (§18.1): never in frontend code, never in the database in plain text, never in logs or audit
  events. Integrations store a credentials *reference* resolved by a `SecretStore` interface (environment
  variables implementation; vault later).
- External events (§18.3): every inbound event is authenticated (signature interface), validated against a
  schema, de-duplicated by (provider, externalId) and logged with its validation result BEFORE any core
  record changes; core changes go through the owning module's public API only. Existing Phase 4 payment
  intake keeps working (it becomes one registered handler of the generic framework, not a second path).
- Background work: one DB-backed job queue (Postgres, `FOR UPDATE SKIP LOCKED`), idempotent handlers
  registered by owning modules, retries with backoff and a dead-letter status, a worker process
  (`npm run worker`) and a scheduler for periodic jobs — replacing the "no scheduler" limitation of Phases
  2–6 (sweeps, recommendation runs, metric recomputation, notification retries). Tenant context is set per job
  (`withTenant`); jobs carry ids, not payload copies of sensitive data.
- Automation (§15.2): rules are auditable, versioned, testable (dry run), scoped, idempotent per
  (rule version, triggering event); loop prevention by causation chain (an action's events carry the chain;
  depth limit + same-rule-same-entity suppression); high-impact rules require approval through the approval
  engine before activation (SoD). Actions only through owning modules' public APIs; no action may change
  compensation, eligibility or employment status, offer discounts automatically (§9.6), or use performance
  data to restrict work (§10.3).
- Payroll (§11.9): export of time and attendance facts only (shifts, approved hours, jobs) to a payroll
  provider interface — no wage, tax, overtime or deduction computation; never described as payroll.
  Accounting: export of ledger entries through a tenant-configurable account mapping that is versioned and
  approval-controlled, labelled "requires review by qualified finance professionals".
- Same module/pipeline/RLS/audit/i18n/doc rules; new migrations only in Task 1.

## Task 1: Phase 7 schema + permission catalog
BackgroundJob (type, tenantId?, payload ids JSON, runAt, priority, attempts, maxAttempts, status
QUEUED | RUNNING | SUCCEEDED | FAILED | DEAD, lockedBy/lockedAt, lastErrorCode, idempotencyKey unique),
ScheduledJobDefinition (key, cron, enabled, lastRunAt), DomainEventOutbox (event type, aggregate, ids,
causation chain, occurredAt, dispatchedAt), AutomationRule + AutomationRuleVersion (trigger, conditions JSON,
actions JSON, scope, priority, status DRAFT | PENDING_APPROVAL | ACTIVE | RETIRED, high-impact flag, approval
ref), AutomationExecution (rule version, event id, result, actions taken, idempotency unique), Integration
(category, provider key, tenant config JSON non-secret, credentialsRef, status NOT_CONFIGURED | CONNECTED |
ERROR | DISABLED, webhook settings, retry policy), IntegrationLog (append-only errors/calls, no secrets),
WebhookEvent (generic inbound: provider, externalId, payload hash, signature result, validation result,
handled result; unique per provider+externalId), AccountingMapping (versioned, approval), ExportBatch
(payroll/accounting export runs). Permission catalog automation.*, integrations.*, exports for payroll /
accounting; templates (Owner/Admin configure; Finance Director accounting exports; HR payroll exports).
RLS (BackgroundJob may be tenant-less for system jobs — document how RLS treats it) + tests.

## Task 2: Job queue, worker, scheduler, outbox
Queue service (enqueue in-tx, claim with SKIP LOCKED, heartbeat, retry/backoff, dead letter), handler
registry (`registerJobHandler`), worker entry point, scheduler that enqueues periodic jobs idempotently
(per definition + window), outbox dispatcher (domain events emitted in the business transaction, delivered
to subscribers by the worker). Register the existing sweeps (follow-ups, training, qualifications expiry,
recommendation generation, notification delivery retries, performance recomputation where defined). Admin
APIs: job status, retry dead job, scheduled definitions enable/disable. Tests incl. concurrency (two workers).

## Task 3: Automation engine (§15)
Trigger catalog (from domain events), conditions (safe declarative operators over event fields — no code),
action registry (create follow-up, notify role/scope, set job/lead priority, create recovery case, add tag
— each implemented by the owning module), versions, dry-run endpoint against a sample or historical event,
activation (high-impact → approval), execution through the outbox subscriber with idempotency + loop
prevention, execution log, metrics. Relationship to the Phase 3 recovery rules engine: decide and document
(either recovery rules become automation rules, or the recovery engine stays and is exposed as an action) —
no second competing engine for the same trigger.

## Task 4: Integration framework (§18)
Integration registry per category with provider interfaces and "not configured" implementations, tenant
configuration CRUD (non-secret config + credentials reference), connection test (truthful), SecretStore
interface (env implementation), generic webhook endpoint `/api/v1/webhooks/{provider}` (signature verify,
schema validate, dedupe, log, enqueue handler job), rate-limit / outage / auth-expiry handling through the
queue (backoff, circuit open status), error logs API. Wire: notification channels (email/SMS/push) resolve
their provider through the registry; marketing lead-source webhooks map into the leads intake (idempotent);
Phase 4 payment intake registered as a handler.

## Task 5: Payroll + accounting exports (§11.9, Phase 7 "Payroll integration", "Accounting integration")
Payroll: period export of time facts (shift durations, approved hours, job counts per employee per day) as
a provider-neutral file + PayrollProvider interface (not configured); approvals before export; never wage
math. Accounting: versioned account mapping (approval), journal export of ledger entries per period (balanced
per currency, reversal-aware), provider-neutral CSV + AccountingProvider interface; re-export idempotent;
audited.

## Task 6: Hardening + MILESTONE-7
Whole-phase review, fixes, docs (ERD, PERMISSIONS, ARCHITECTURE, API_REFERENCE, OPERATIONS.md for running the
worker/scheduler), `docs/MILESTONE-7.md` with limitations (no provider configured, env SecretStore only,
UI deferred, compensation blocked) and rulings for the improvement round.
