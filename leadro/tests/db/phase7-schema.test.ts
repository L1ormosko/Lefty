import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { createTenant } from "../helpers";

/**
 * Phase 7 schema (migration 20261128100000_phase7_integrations_automation): tenant isolation (incl. tenant-less system jobs and the
 * queue-worker policy), composite tenant-safe foreign keys, CHECKs (no secrets, truthful statuses, signature / validation gates),
 * idempotency uniques, status machines, frozen content and the append-only logs. Constraint, index, policy and trigger names
 * asserted here are part of the migration contract.
 */

interface Graph {
  tenantId: string;
  userId: string;
  otherUserId: string;
  orgUnitId: string;
  legalEntityId: string;
  ruleId: string;
  draftVersionId: string;
  eventId: string;
  integrationId: string;
  webhookEventId: string;
  logId: string;
  executionId: string;
  mappingId: string;
  jobId: string;
}

const suffix = Math.random().toString(36).slice(2, 7);
const HASH = "b".repeat(64);
const HASH2 = "c".repeat(64);
let A: Graph;
let B: Graph;

async function approvalRequest(tx: TenantTx, tenantId: string, userId: string, subjectType: "AUTOMATION_RULE_VERSION" | "ACCOUNTING_MAPPING" | "PAYROLL_EXPORT") {
  const code = `${subjectType.toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`;
  const permission = { AUTOMATION_RULE_VERSION: "automation.approve", ACCOUNTING_MAPPING: "accounting_exports.approve", PAYROLL_EXPORT: "payroll_exports.approve" }[subjectType];
  const policy = await tx.approvalPolicy.create({ data: { tenantId, code, subjectType, name: code, approverPermission: permission } });
  return tx.approvalRequest.create({
    data: {
      tenantId, subjectType, subjectId: `subject-${code}`, policyId: policy.id, policyCode: policy.code, policyVersion: 1, requiredApprovals: 1,
      approverPermission: permission, requestedById: userId,
    },
  });
}

async function buildGraph(label: string): Promise<Graph> {
  const tenant = await createTenant(label);
  const tenantId = tenant.id;
  return withTenant(tenantId, async (tx) => {
    const user = await tx.user.create({ data: { tenantId, email: `a-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const other = await tx.user.create({ data: { tenantId, email: `b-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const orgUnit = await tx.orgUnit.create({ data: { tenantId, type: "STATE", name: `State ${label}` } });
    const legalEntity = await tx.legalEntity.create({ data: { tenantId, name: `LE ${label}` } });
    const rule = await tx.automationRule.create({ data: { tenantId, key: "not_sold_recovery", name: "Not sold recovery", createdById: user.id } });
    const draft = await tx.automationRuleVersion.create({
      data: {
        tenantId, ruleId: rule.id, version: 1, trigger: "job_outcome.reported", conditions: [{ field: "reason", op: "eq", value: "price" }],
        actions: [{ type: "recovery.create_case" }], scopeOrgUnitId: orgUnit.id, createdById: user.id,
      },
    });
    const event = await tx.domainEventOutbox.create({
      data: { tenantId, eventType: "job_outcome.reported", aggregateType: "Job", aggregateId: "job-1", payload: { outcomeId: "o-1" }, actorUserId: user.id },
    });
    const integration = await tx.integration.create({
      data: { tenantId, key: "sms_main", category: "SMS", providerKey: "twilio", name: "SMS", config: { fromNumber: "+15550100" }, createdById: user.id },
    });
    const webhook = await tx.webhookEvent.create({
      data: {
        tenantId, integrationId: integration.id, provider: "twilio", externalId: "evt-1", eventType: "message.status", payloadHash: HASH,
        signatureResult: "VALID", validationResult: "VALID", handlingStatus: "RECEIVED", parsed: { messageId: "m-1" },
      },
    });
    const log = await tx.integrationLog.create({
      data: { tenantId, integrationId: integration.id, webhookEventId: webhook.id, kind: "WEBHOOK", outcome: "SUCCESS", operation: "webhook.receive" },
    });
    const execution = await tx.automationExecution.create({
      data: {
        tenantId, ruleId: rule.id, ruleVersionId: draft.id, triggerEventId: event.id, entityType: "Job", entityId: "job-1", result: "NOT_MATCHED",
        causationDepth: 0,
      },
    });
    const mapping = await tx.accountingMapping.create({
      data: { tenantId, legalEntityId: legalEntity.id, version: 1, mappings: [{ ledgerEntryType: "CHARGE", debitAccount: "1100", creditAccount: "4000" }], createdById: user.id },
    });
    const job = await tx.backgroundJob.create({ data: { tenantId, type: "follow_ups.due_sweep", idempotencyKey: `sweep-${label}` } });
    return {
      tenantId, userId: user.id, otherUserId: other.id, orgUnitId: orgUnit.id, legalEntityId: legalEntity.id, ruleId: rule.id, draftVersionId: draft.id,
      eventId: event.id, integrationId: integration.id, webhookEventId: webhook.id, logId: log.id, executionId: execution.id, mappingId: mapping.id,
      jobId: job.id,
    };
  });
}

/** Runs `fn` in a transaction on the queue-worker path (`app.queue_worker = 'on'`, no tenant). */
function asQueueWorker<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.queue_worker', 'on', true)`;
    return fn(tx);
  });
}

let systemJobKey: string;

beforeAll(async () => {
  A = await buildGraph("p7a");
  B = await buildGraph("p7b");
  systemJobKey = `system-sweep-${suffix}`;
  await asQueueWorker((tx) => tx.backgroundJob.create({ data: { type: "scheduler.fan_out", idempotencyKey: systemJobKey } }));
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const rejects = (g: Graph, rule: RegExp | string, fn: (tx: TenantTx) => Promise<unknown>) => expect(withTenant(g.tenantId, fn)).rejects.toThrow(rule);
const run = <T>(g: Graph, fn: (tx: TenantTx) => Promise<T>) => withTenant(g.tenantId, fn);

const integration = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, key: `i_${Math.random().toString(36).slice(2, 8)}`, category: "EMAIL" as const, providerKey: "smtp", name: "Email",
  createdById: g.userId, ...over,
});
const webhook = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, provider: "twilio", externalId: `evt-${Math.random().toString(36).slice(2, 10)}`, eventType: "message.status",
  payloadHash: HASH2, signatureResult: "VALID" as const, validationResult: "VALID" as const, handlingStatus: "RECEIVED" as const, ...over,
});
let versionCounter = 10;
const ruleVersion = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, ruleId: g.ruleId, version: (versionCounter += 1), trigger: "job_outcome.reported", actions: [{ type: "follow_ups.create" }],
  createdById: g.userId, ...over,
});
let batchCounter = 0;
const payrollBatch = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, kind: "PAYROLL" as const, periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-11-16"), contentHash: HASH,
  rowCount: 3, idempotencyKey: `payroll-${(batchCounter += 1)}-${suffix}`, preparedById: g.userId, ...over,
});

describe("tenant isolation of every Phase 7 table", () => {
  const TABLES = [
    "BackgroundJob", "DomainEventOutbox", "AutomationRule", "AutomationRuleVersion", "AutomationExecution", "Integration", "IntegrationLog",
    "WebhookEvent", "AccountingMapping",
  ];

  it.each(TABLES)("%s: each tenant sees only its own rows, and nothing without a context", async (table) => {
    const own = (g: Graph) =>
      withTenant(g.tenantId, async (tx) => (await tx.$queryRawUnsafe<{ tenantId: string | null }[]>(`SELECT "tenantId" FROM "${table}"`)).map((r) => r.tenantId));
    expect(new Set(await own(A))).toEqual(new Set([A.tenantId]));
    expect(new Set(await own(B))).toEqual(new Set([B.tenantId]));
    expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`)).toEqual([]);
  });

  it("a tenant cannot insert a Phase 7 row under another tenant's id, nor a system job", async () => {
    await rejects(A, /row-level security/, (tx) => tx.integration.create({ data: integration(B) }));
    await rejects(A, /row-level security/, (tx) => tx.backgroundJob.create({ data: { tenantId: B.tenantId, type: "x.y" } }));
    await rejects(A, /row-level security/, (tx) => tx.backgroundJob.create({ data: { type: "x.y" } }));
    await rejects(A, /row-level security/, (tx) => tx.scheduledJobDefinition.create({ data: { key: "x.y", jobType: "x.y", cron: "* * * * *" } }));
  });
});

describe("system (tenant-less) rows and the queue-worker policy", () => {
  it("a system job is invisible to every tenant and to a context-less session", async () => {
    expect(await run(A, (tx) => tx.backgroundJob.count({ where: { idempotencyKey: systemJobKey } }))).toBe(0);
    expect(await run(B, (tx) => tx.backgroundJob.count({ where: { tenantId: null } }))).toBe(0);
    expect(await prisma.backgroundJob.count()).toBe(0);
  });

  it("the queue-worker path sees system and tenant jobs, definitions and events of every tenant", async () => {
    const seen = await asQueueWorker(async (tx) => ({
      jobs: await tx.backgroundJob.findMany({ where: { OR: [{ id: { in: [A.jobId, B.jobId] } }, { idempotencyKey: systemJobKey }] } }),
      events: await tx.domainEventOutbox.count({ where: { id: { in: [A.eventId, B.eventId] } } }),
    }));
    expect(seen.jobs.map((j) => j.tenantId).sort()).toEqual([A.tenantId, B.tenantId, null].sort());
    expect(seen.events).toBe(2);
  });

  it("the queue-worker policy exists on the three queue tables only", async () => {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'queue_worker' ORDER BY 1`;
    expect(rows.map((r) => r.tablename)).toEqual(["BackgroundJob", "DomainEventOutbox", "ScheduledJobDefinition"]);
  });

  it("the worker setting does not leak to the next transaction", async () => {
    await asQueueWorker((tx) => tx.backgroundJob.count());
    expect(await prisma.backgroundJob.count()).toBe(0);
  });

  it("system definitions share one key namespace; a tenant may define the same key once", async () => {
    const key = `sweeps.k_${suffix}`;
    await asQueueWorker((tx) => tx.scheduledJobDefinition.create({ data: { key, jobType: "follow_ups.due_sweep", cron: "*/15 * * * *" } }));
    await expect(asQueueWorker((tx) => tx.scheduledJobDefinition.create({ data: { key, jobType: "follow_ups.due_sweep", cron: "0 * * * *" } }))).rejects.toThrow(
      /scheduled_job_definition_key|Unique constraint/,
    );
    await run(A, (tx) => tx.scheduledJobDefinition.create({ data: { tenantId: A.tenantId, key, jobType: "follow_ups.due_sweep", cron: "0 6 * * 1-5" } }));
    await rejects(A, /scheduled_job_definition_key|Unique constraint/, (tx) =>
      tx.scheduledJobDefinition.create({ data: { tenantId: A.tenantId, key, jobType: "follow_ups.due_sweep", cron: "0 7 * * *" } }),
    );
  });

  it("system jobs share one idempotency namespace; tenants have their own", async () => {
    await expect(asQueueWorker((tx) => tx.backgroundJob.create({ data: { type: "scheduler.fan_out", idempotencyKey: systemJobKey } }))).rejects.toThrow(
      /background_job_idempotency|Unique constraint/,
    );
    await rejects(A, /background_job_idempotency|Unique constraint/, (tx) =>
      tx.backgroundJob.create({ data: { tenantId: A.tenantId, type: "follow_ups.due_sweep", idempotencyKey: "sweep-p7a" } }),
    );
    // The same key in another tenant, and jobs without a key, are fine.
    await run(B, (tx) => tx.backgroundJob.create({ data: { tenantId: B.tenantId, type: "follow_ups.due_sweep", idempotencyKey: "sweep-p7a" } }));
    await run(A, (tx) => tx.backgroundJob.create({ data: { tenantId: A.tenantId, type: "follow_ups.due_sweep" } }));
    await run(A, (tx) => tx.backgroundJob.create({ data: { tenantId: A.tenantId, type: "follow_ups.due_sweep" } }));
  });
});

describe("composite foreign keys keep references inside one tenant", () => {
  it("rule versions, executions, logs, webhooks, mappings and batches cannot point into another tenant", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { ruleId: B.ruleId }) }));
    await rejects(A, /foreign key/i, (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { scopeOrgUnitId: B.orgUnitId }) }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.automationExecution.create({
        data: { tenantId: A.tenantId, ruleId: A.ruleId, ruleVersionId: A.draftVersionId, triggerEventId: B.eventId, entityType: "Job", entityId: "j", result: "NOT_MATCHED", causationDepth: 0 },
      }),
    );
    await rejects(A, /foreign key/i, (tx) =>
      tx.integrationLog.create({ data: { tenantId: A.tenantId, integrationId: B.integrationId, kind: "CALL", outcome: "SUCCESS", operation: "sms.send" } }),
    );
    await rejects(A, /foreign key/i, (tx) => tx.webhookEvent.create({ data: webhook(A, { integrationId: B.integrationId }) }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.accountingMapping.create({ data: { tenantId: A.tenantId, legalEntityId: B.legalEntityId, version: 9, mappings: [{}], createdById: A.userId } }),
    );
    await rejects(A, /foreign key/i, (tx) => tx.exportBatch.create({ data: payrollBatch(A, { legalEntityId: B.legalEntityId }) }));
  });

  it("an execution's version must belong to its rule", async () => {
    const otherRule = await run(A, (tx) => tx.automationRule.create({ data: { tenantId: A.tenantId, key: `other_${suffix}`, name: "Other", createdById: A.userId } }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.automationExecution.create({
        data: { tenantId: A.tenantId, ruleId: otherRule.id, ruleVersionId: A.draftVersionId, triggerEventId: A.eventId, entityType: "Job", entityId: "j", result: "NOT_MATCHED", causationDepth: 0 },
      }),
    );
  });
});

describe("background jobs", () => {
  it("checks type, payload size, attempts, lock and error facts", async () => {
    const job = (over: Record<string, unknown>) => ({ tenantId: A.tenantId, type: "follow_ups.due_sweep", ...over });
    await rejects(A, "background_job_type_format", (tx) => tx.backgroundJob.create({ data: job({ type: "Sweep" }) }));
    await rejects(A, "background_job_payload_small", (tx) => tx.backgroundJob.create({ data: job({ payload: ["id"] }) }));
    await rejects(A, "background_job_payload_small", (tx) => tx.backgroundJob.create({ data: job({ payload: { blob: "x".repeat(5000) } }) }));
    await rejects(A, "background_job_attempts", (tx) => tx.backgroundJob.create({ data: job({ attempts: 6, maxAttempts: 5 }) }));
    await rejects(A, "background_job_lock", (tx) => tx.backgroundJob.create({ data: job({ status: "RUNNING" }) }));
    await rejects(A, "background_job_lock", (tx) => tx.backgroundJob.create({ data: job({ lockedBy: "w1", lockedAt: new Date() }) }));
    await rejects(A, "background_job_error", (tx) => tx.backgroundJob.create({ data: job({ status: "DEAD" }) }));
    await rejects(A, "background_job_error", (tx) =>
      tx.backgroundJob.create({ data: job({ status: "DEAD", lastErrorCode: "TypeError: x is undefined", lastErrorAt: new Date() }) }),
    );
    await rejects(A, "background_job_completed", (tx) => tx.backgroundJob.create({ data: job({ completedAt: new Date() }) }));
  });

  it("follows the queue state machine and keeps its identity", async () => {
    const job = await run(A, (tx) => tx.backgroundJob.create({ data: { tenantId: A.tenantId, type: "notifications.retry", payload: { deliveryId: "d1" } } }));
    const now = new Date();
    await run(A, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockedBy: "w1", lockedAt: now, heartbeatAt: now, attempts: 1 } }));
    await run(A, (tx) =>
      tx.backgroundJob.update({ where: { id: job.id }, data: { status: "FAILED", lockedBy: null, lockedAt: null, lastErrorCode: "provider_timeout", lastErrorAt: now } }),
    );
    await run(A, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockedBy: "w2", lockedAt: now, attempts: 2 } }));
    await run(A, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { status: "DEAD", lockedBy: null, lockedAt: null } }));
    await run(A, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { status: "QUEUED" } }));
    await rejects(A, /status transition QUEUED -> SUCCEEDED/, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", completedAt: now } }));
    await rejects(A, /immutable/, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { payload: { deliveryId: "d2" } } }));
    await rejects(A, /immutable/, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { type: "other.job" } }));
    await rejects(A, /only SUCCEEDED/, (tx) => tx.backgroundJob.delete({ where: { id: job.id } }));
  });

  it("allows deleting a SUCCEEDED job (retention) and never resurrects one", async () => {
    const job = await run(A, (tx) => tx.backgroundJob.create({ data: { tenantId: A.tenantId, type: "notifications.retry" } }));
    const now = new Date();
    await run(A, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockedBy: "w1", lockedAt: now } }));
    await run(A, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", lockedBy: null, lockedAt: null, completedAt: now } }));
    await rejects(A, /status transition SUCCEEDED -> QUEUED/, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { status: "QUEUED", completedAt: null } }));
    await run(A, (tx) => tx.backgroundJob.delete({ where: { id: job.id } }));
  });
});

describe("scheduled job definitions", () => {
  it("checks the cron shape, the time zone and the key, and is never deleted", async () => {
    const def = (over: Record<string, unknown>) => ({ tenantId: A.tenantId, key: `d_${Math.random().toString(36).slice(2, 8)}`, jobType: "follow_ups.due_sweep", cron: "0 * * * *", ...over });
    await rejects(A, "scheduled_job_definition_cron_shape", (tx) => tx.scheduledJobDefinition.create({ data: def({ cron: "every hour" }) }));
    await rejects(A, "scheduled_job_definition_cron_shape", (tx) => tx.scheduledJobDefinition.create({ data: def({ cron: "* * * *" }) }));
    await rejects(A, "scheduled_job_definition_time_zone_shape", (tx) => tx.scheduledJobDefinition.create({ data: def({ timeZone: "../etc" }) }));
    await rejects(A, "scheduled_job_definition_key_format", (tx) => tx.scheduledJobDefinition.create({ data: def({ key: "Bad Key" }) }));
    await rejects(A, "scheduled_job_definition_last_run", (tx) => tx.scheduledJobDefinition.create({ data: def({ lastRunAt: new Date() }) }));
    const created = await run(A, (tx) => tx.scheduledJobDefinition.create({ data: def({ timeZone: "America/New_York" }) }));
    await run(A, (tx) => tx.scheduledJobDefinition.update({ where: { id: created.id }, data: { enabled: false } }));
    await rejects(A, /immutable/, (tx) => tx.scheduledJobDefinition.update({ where: { id: created.id }, data: { key: "renamed" } }));
    await rejects(A, /never deleted/, (tx) => tx.scheduledJobDefinition.delete({ where: { id: created.id } }));
  });
});

describe("domain event outbox", () => {
  it("checks type, aggregate, payload, causation chain and actor", async () => {
    const ev = (over: Record<string, unknown>) => ({ tenantId: A.tenantId, eventType: "job.completed", aggregateType: "Job", aggregateId: "j1", ...over });
    await rejects(A, "domain_event_type_format", (tx) => tx.domainEventOutbox.create({ data: ev({ eventType: "JobCompleted" }) }));
    await rejects(A, "domain_event_aggregate", (tx) => tx.domainEventOutbox.create({ data: ev({ aggregateType: "job" }) }));
    await rejects(A, "domain_event_payload_small", (tx) => tx.domainEventOutbox.create({ data: ev({ payload: { notes: "x".repeat(9000) } }) }));
    await rejects(A, "domain_event_causation_chain", (tx) =>
      tx.domainEventOutbox.create({ data: ev({ causationChain: Array.from({ length: 17 }, (_, i) => `e${i}`) }) }),
    );
    await rejects(A, "domain_event_rule_cause", (tx) => tx.domainEventOutbox.create({ data: ev({ causedByRuleVersionId: A.draftVersionId }) }));
    await rejects(A, "domain_event_actor", (tx) => tx.domainEventOutbox.create({ data: ev({ actorUserId: A.userId, systemActor: "system:automation" }) }));
    await rejects(A, "domain_event_actor", (tx) => tx.domainEventOutbox.create({ data: ev({ systemActor: "automation" }) }));
    await run(A, (tx) =>
      tx.domainEventOutbox.create({ data: ev({ causationChain: [A.eventId], causedByRuleVersionId: A.draftVersionId, systemActor: "system:automation" }) }),
    );
  });

  it("is a fact: only dispatchedAt is written, once; never deleted", async () => {
    const ev = await run(A, (tx) => tx.domainEventOutbox.create({ data: { tenantId: A.tenantId, eventType: "lead.created", aggregateType: "Lead", aggregateId: "l1" } }));
    await rejects(A, /immutable/, (tx) => tx.domainEventOutbox.update({ where: { id: ev.id }, data: { aggregateId: "l2" } }));
    await run(A, (tx) => tx.domainEventOutbox.update({ where: { id: ev.id }, data: { dispatchedAt: new Date() } }));
    await rejects(A, /set once/, (tx) => tx.domainEventOutbox.update({ where: { id: ev.id }, data: { dispatchedAt: new Date(Date.now() + 1000) } }));
    await rejects(A, /set once/, (tx) => tx.domainEventOutbox.update({ where: { id: ev.id }, data: { dispatchedAt: null } }));
    await rejects(A, /never deleted/, (tx) => tx.domainEventOutbox.delete({ where: { id: ev.id } }));
  });
});

describe("automation rules and versions", () => {
  it("checks the rule's key, name and archive pair; key and author frozen; never deleted", async () => {
    await rejects(A, "automation_rule_key_format", (tx) => tx.automationRule.create({ data: { tenantId: A.tenantId, key: "Not Sold", name: "x", createdById: A.userId } }));
    await rejects(A, "automation_rule_name_present", (tx) => tx.automationRule.create({ data: { tenantId: A.tenantId, key: "k1", name: " ", createdById: A.userId } }));
    await rejects(A, "automation_rule_archived", (tx) =>
      tx.automationRule.create({ data: { tenantId: A.tenantId, key: "k2", name: "x", createdById: A.userId, archivedAt: new Date() } }),
    );
    await rejects(A, /Unique constraint/, (tx) => tx.automationRule.create({ data: { tenantId: A.tenantId, key: "not_sold_recovery", name: "dup", createdById: A.userId } }));
    await rejects(A, /immutable/, (tx) => tx.automationRule.update({ where: { id: A.ruleId }, data: { key: "renamed" } }));
    await rejects(A, /never deleted/, (tx) => tx.automationRule.delete({ where: { id: A.ruleId } }));
  });

  it("checks trigger, conditions, actions, priority and secrets", async () => {
    await rejects(A, "automation_rule_version_trigger_format", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { trigger: "NotSold" }) }));
    await rejects(A, "automation_rule_version_actions_shape", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { actions: [] }) }));
    await rejects(A, "automation_rule_version_actions_shape", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { actions: [{ to: "x" }] }) }));
    await rejects(A, "automation_rule_version_actions_shape", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { actions: { type: "x" } }) }));
    await rejects(A, "automation_rule_version_actions_shape", (tx) =>
      tx.automationRuleVersion.create({ data: ruleVersion(A, { actions: Array.from({ length: 21 }, () => ({ type: "tag.add" })) }) }),
    );
    await rejects(A, "automation_rule_version_conditions_shape", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { conditions: ["reason = price"] }) }));
    await rejects(A, "automation_rule_version_priority_range", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { priority: -1 }) }));
    await rejects(A, "automation_rule_version_no_secrets", (tx) =>
      tx.automationRuleVersion.create({ data: ruleVersion(A, { actions: [{ type: "webhook.call", headers: { apiKey: "sk_live" } }] }) }),
    );
    await rejects(A, "automation_rule_version_number", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { version: 0 }) }));
  });

  it("needs an approval request for a pending or high-impact active version; one ACTIVE per rule", async () => {
    const now = new Date();
    await rejects(A, "automation_rule_version_pending", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { status: "PENDING_APPROVAL", submittedAt: now }) }));
    await rejects(A, "automation_rule_version_active", (tx) =>
      tx.automationRuleVersion.create({ data: ruleVersion(A, { status: "ACTIVE", activatedAt: now, highImpact: true }) }),
    );
    await rejects(A, "automation_rule_version_active", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { status: "ACTIVE" }) }));
    await rejects(A, "automation_rule_version_retired", (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { status: "RETIRED" }) }));
    // A low-impact version may be activated without approval; a second ACTIVE version of the same rule is refused.
    const active = await run(A, (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { status: "ACTIVE", activatedAt: now }) }));
    await rejects(A, /automation_rule_version_one_active|Unique constraint/, (tx) =>
      tx.automationRuleVersion.create({ data: ruleVersion(A, { status: "ACTIVE", activatedAt: now }) }),
    );
    // High-impact: DRAFT -> PENDING_APPROVAL (with the request) -> ACTIVE, after retiring the current one.
    const request = await run(A, (tx) => approvalRequest(tx, A.tenantId, A.userId, "AUTOMATION_RULE_VERSION"));
    const high = await run(A, (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A, { highImpact: true }) }));
    await run(A, (tx) =>
      tx.automationRuleVersion.update({ where: { id: high.id }, data: { status: "PENDING_APPROVAL", submittedAt: now, approvalRequestId: request.id } }),
    );
    await run(A, async (tx) => {
      await tx.automationRuleVersion.update({ where: { id: active.id }, data: { status: "RETIRED", retiredAt: now } });
      await tx.automationRuleVersion.update({ where: { id: high.id }, data: { status: "ACTIVE", activatedAt: now } });
    });
    await rejects(A, /status transition ACTIVE -> DRAFT/, (tx) => tx.automationRuleVersion.update({ where: { id: high.id }, data: { status: "DRAFT" } }));
    await rejects(A, /status transition RETIRED -> ACTIVE/, (tx) => tx.automationRuleVersion.update({ where: { id: active.id }, data: { status: "ACTIVE" } }));
  });

  it("is editable only as DRAFT; frozen once submitted; never deleted", async () => {
    const now = new Date();
    const v = await run(A, (tx) => tx.automationRuleVersion.create({ data: ruleVersion(A) }));
    await run(A, (tx) => tx.automationRuleVersion.update({ where: { id: v.id }, data: { priority: 5, actions: [{ type: "tag.add", tag: "price" }] } }));
    const request = await run(A, (tx) => approvalRequest(tx, A.tenantId, A.userId, "AUTOMATION_RULE_VERSION"));
    await run(A, (tx) => tx.automationRuleVersion.update({ where: { id: v.id }, data: { status: "PENDING_APPROVAL", submittedAt: now, approvalRequestId: request.id } }));
    for (const data of [{ actions: [{ type: "tag.add" }] }, { conditions: [{ field: "reason" }] }, { trigger: "lead.created" }, { priority: 6 }, { highImpact: true }, { scopeOrgUnitId: A.orgUnitId }]) {
      await rejects(A, /frozen/, (tx) => tx.automationRuleVersion.update({ where: { id: v.id }, data }));
    }
    await rejects(A, /immutable/, (tx) => tx.automationRuleVersion.update({ where: { id: v.id }, data: { version: 99 } }));
    await rejects(A, /never deleted/, (tx) => tx.automationRuleVersion.delete({ where: { id: v.id } }));
  });
});

describe("automation executions", () => {
  const execution = (g: Graph, over: Record<string, unknown> = {}) => ({
    tenantId: g.tenantId, ruleId: g.ruleId, ruleVersionId: g.draftVersionId, triggerEventId: g.eventId, entityType: "Job", entityId: "job-1",
    result: "EXECUTED" as const, causationDepth: 0, ...over,
  });

  it("runs a rule version at most once per triggering event", async () => {
    await rejects(A, /Unique constraint/, (tx) => tx.automationExecution.create({ data: execution(A) }));
  });

  it("checks result facts, entity, depth and actions", async () => {
    const event = await run(A, (tx) => tx.domainEventOutbox.create({ data: { tenantId: A.tenantId, eventType: "job.completed", aggregateType: "Job", aggregateId: "j9" } }));
    const at = (over: Record<string, unknown>) => execution(A, { triggerEventId: event.id, ...over });
    await rejects(A, "automation_execution_error", (tx) => tx.automationExecution.create({ data: at({ result: "FAILED" }) }));
    await rejects(A, "automation_execution_error", (tx) => tx.automationExecution.create({ data: at({ errorCode: "boom" }) }));
    await rejects(A, "automation_execution_no_actions_when_skipped", (tx) =>
      tx.automationExecution.create({ data: at({ result: "SUPPRESSED_REPEAT", actionsTaken: [{ type: "tag.add", status: "DONE" }] }) }),
    );
    await rejects(A, "automation_execution_depth", (tx) => tx.automationExecution.create({ data: at({ causationDepth: 17 }) }));
    await rejects(A, "automation_execution_entity", (tx) => tx.automationExecution.create({ data: at({ entityType: "job" }) }));
    await rejects(A, "automation_execution_actions_shape", (tx) => tx.automationExecution.create({ data: at({ actionsTaken: "done" }) }));
    await run(A, (tx) => tx.automationExecution.create({ data: at({ actionsTaken: [{ type: "follow_ups.create", status: "DONE", recordType: "FollowUpTask", recordId: "f1" }] }) }));
  });

  it("is append-only: UPDATE, DELETE and TRUNCATE are rejected", async () => {
    await rejects(A, /append-only/, (tx) => tx.automationExecution.update({ where: { id: A.executionId }, data: { result: "FAILED", errorCode: "x" } }));
    await rejects(A, /append-only/, (tx) => tx.automationExecution.delete({ where: { id: A.executionId } }));
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "AutomationExecution"`)).rejects.toThrow(/append-only/);
  });
});

describe("integrations", () => {
  it("stores no secrets: no secret-looking config keys at any depth, only a credentials reference", async () => {
    await rejects(A, "integration_config_no_secrets", (tx) => tx.integration.create({ data: integration(A, { config: { apiKey: "sk_live_123" } }) }));
    await rejects(A, "integration_config_no_secrets", (tx) => tx.integration.create({ data: integration(A, { config: { smtp: { password: "hunter2" } } }) }));
    await rejects(A, "integration_config_no_secrets", (tx) => tx.integration.create({ data: integration(A, { config: { list: [{ Client_Secret: "x" }] } }) }));
    await rejects(A, "integration_config_no_secrets", (tx) => tx.integration.create({ data: integration(A, { config: ["not", "an", "object"] }) }));
    await rejects(A, "integration_webhook_settings_no_secrets", (tx) =>
      tx.integration.create({ data: integration(A, { webhookSettings: { signingSecret: "whsec_1" } }) }),
    );
    for (const credentialsRef of ["sk_live_123", "env:lower_case", "vault:", "env:TOKEN with space", "https://vault/x"]) {
      await rejects(A, "integration_credentials_ref_format", (tx) => tx.integration.create({ data: integration(A, { credentialsRef }) }));
    }
    await run(A, (tx) => tx.integration.create({ data: integration(A, { credentialsRef: "env:LEADRO_ACME_SMTP_PASSWORD", config: { host: "smtp.example.com", port: 587 } }) }));
    await run(A, (tx) => tx.integration.create({ data: integration(A, { credentialsRef: "vault:leadro/acme/smtp" }) }));
  });

  it("has no column that could hold a secret", async () => {
    const rows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('Integration', 'IntegrationLog', 'WebhookEvent')
        AND column_name ~* '(secret|passw|token|api_?key|private)'`;
    expect(rows).toEqual([]);
  });

  it("reports its status truthfully and authenticates webhooks", async () => {
    await rejects(A, "integration_status_facts", (tx) => tx.integration.create({ data: integration(A, { status: "CONNECTED" }) }));
    await rejects(A, "integration_status_facts", (tx) => tx.integration.create({ data: integration(A, { status: "ERROR" }) }));
    await rejects(A, "integration_status_facts", (tx) => tx.integration.create({ data: integration(A, { status: "ERROR", statusCode: "Auth expired!" }) }));
    await rejects(A, "integration_webhook_needs_credentials", (tx) => tx.integration.create({ data: integration(A, { webhookEnabled: true }) }));
    await rejects(A, "integration_retry_policy", (tx) => tx.integration.create({ data: integration(A, { retryBaseDelaySeconds: 600, retryMaxDelaySeconds: 60 }) }));
    await rejects(A, "integration_retry_policy", (tx) => tx.integration.create({ data: integration(A, { retryMaxAttempts: 0 }) }));
    await run(A, (tx) => tx.integration.create({ data: integration(A, { status: "ERROR", statusCode: "auth_expired" }) }));
  });

  it("keeps key, category and provider; never deleted", async () => {
    await rejects(A, /immutable/, (tx) => tx.integration.update({ where: { id: A.integrationId }, data: { category: "EMAIL" } }));
    await rejects(A, /immutable/, (tx) => tx.integration.update({ where: { id: A.integrationId }, data: { providerKey: "other" } }));
    await run(A, (tx) => tx.integration.update({ where: { id: A.integrationId }, data: { status: "DISABLED", updatedById: A.otherUserId } }));
    await rejects(A, /never deleted/, (tx) => tx.integration.delete({ where: { id: A.integrationId } }));
  });
});

describe("integration logs", () => {
  it("checks subject, codes, numbers and secrets, and is append-only", async () => {
    const log = (over: Record<string, unknown>) => ({ tenantId: A.tenantId, integrationId: A.integrationId, kind: "CALL" as const, outcome: "SUCCESS" as const, operation: "sms.send", ...over });
    await rejects(A, "integration_log_subject", (tx) => tx.integrationLog.create({ data: log({ integrationId: null }) }));
    await rejects(A, "integration_log_error", (tx) => tx.integrationLog.create({ data: log({ outcome: "FAILURE" }) }));
    await rejects(A, "integration_log_error", (tx) => tx.integrationLog.create({ data: log({ outcome: "FAILURE", errorCode: "HTTP 500: Internal error at ..." }) }));
    await rejects(A, "integration_log_numbers", (tx) => tx.integrationLog.create({ data: log({ httpStatus: 42 }) }));
    await rejects(A, "integration_log_operation_format", (tx) => tx.integrationLog.create({ data: log({ operation: "POST /messages" }) }));
    await rejects(A, "integration_log_details_no_secrets", (tx) => tx.integrationLog.create({ data: log({ details: { authorization: "x", bearerToken: "abc" } }) }));
    await run(A, (tx) => tx.integrationLog.create({ data: log({ outcome: "FAILURE", errorCode: "rate_limited", httpStatus: 429, durationMs: 120, attempt: 2 }) }));
    await rejects(A, /append-only/, (tx) => tx.integrationLog.update({ where: { id: A.logId }, data: { operation: "x.y" } }));
    await rejects(A, /append-only/, (tx) => tx.integrationLog.delete({ where: { id: A.logId } }));
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "IntegrationLog"`)).rejects.toThrow(/append-only/);
  });
});

describe("webhook events", () => {
  it("is unique per tenant, provider and external id (duplicate deliveries are no-ops)", async () => {
    await rejects(A, /Unique constraint/, (tx) => tx.webhookEvent.create({ data: webhook(A, { externalId: "evt-1" }) }));
    await run(B, (tx) => tx.webhookEvent.create({ data: webhook(B, { externalId: "evt-shared" }) }));
    await run(A, (tx) => tx.webhookEvent.create({ data: webhook(A, { externalId: "evt-shared" }) }));
  });

  it("never validates or handles a forged event, and stores it under its body hash", async () => {
    const forged = { signatureResult: "INVALID" as const, validationResult: "SKIPPED" as const, handlingStatus: "REJECTED" as const, rejectionCode: "bad_signature" };
    await rejects(A, "webhook_event_signature_gate", (tx) => tx.webhookEvent.create({ data: webhook(A, { ...forged, externalId: "evt-real" }) }));
    await rejects(A, "webhook_event_signature_gate", (tx) =>
      tx.webhookEvent.create({ data: webhook(A, { ...forged, externalId: `unverified:${HASH2}`, handlingStatus: "RECEIVED", rejectionCode: null }) }),
    );
    await rejects(A, "webhook_event_signature_gate", (tx) =>
      tx.webhookEvent.create({ data: webhook(A, { ...forged, externalId: `unverified:${HASH2}`, validationResult: "VALID" }) }),
    );
    await run(A, (tx) => tx.webhookEvent.create({ data: webhook(A, { ...forged, externalId: `unverified:${HASH2}` }) }));
    await rejects(A, "webhook_event_validated_when_signed", (tx) => tx.webhookEvent.create({ data: webhook(A, { validationResult: "SKIPPED" }) }));
  });

  it("never handles an invalid payload; rejection, handling and parsed facts are consistent", async () => {
    await rejects(A, "webhook_event_validation_gate", (tx) => tx.webhookEvent.create({ data: webhook(A, { validationResult: "INVALID" }) }));
    await rejects(A, "webhook_event_rejection_code", (tx) =>
      tx.webhookEvent.create({ data: webhook(A, { validationResult: "INVALID", handlingStatus: "REJECTED" }) }),
    );
    await rejects(A, "webhook_event_rejection_code", (tx) => tx.webhookEvent.create({ data: webhook(A, { rejectionCode: "schema_invalid" }) }));
    await rejects(A, "webhook_event_parsed", (tx) =>
      tx.webhookEvent.create({ data: webhook(A, { validationResult: "INVALID", handlingStatus: "REJECTED", rejectionCode: "schema_invalid", parsed: { a: 1 } }) }),
    );
    await rejects(A, "webhook_event_parsed", (tx) => tx.webhookEvent.create({ data: webhook(A, { parsed: { token: "abc" } }) }));
    await rejects(A, "webhook_event_handling", (tx) => tx.webhookEvent.create({ data: webhook(A, { handlingStatus: "HANDLED" }) }));
    await rejects(A, "webhook_event_hash_format", (tx) => tx.webhookEvent.create({ data: webhook(A, { payloadHash: "XYZ".padEnd(64, "0") }) }));
    await run(A, (tx) => tx.webhookEvent.create({ data: webhook(A, { validationResult: "INVALID", handlingStatus: "REJECTED", rejectionCode: "schema_invalid" }) }));
  });

  it("only the handling outcome changes, along RECEIVED -> HANDLED | FAILED -> RECEIVED; never deleted", async () => {
    const ev = await run(A, (tx) => tx.webhookEvent.create({ data: webhook(A) }));
    await rejects(A, /immutable/, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { externalId: "evt-other" } }));
    await rejects(A, /immutable/, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { signatureResult: "INVALID" } }));
    await rejects(A, /immutable/, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { parsed: { messageId: "m-2" } } }));
    await run(A, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { handlingStatus: "FAILED", handlingCode: "handler_dead" } }));
    await run(A, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { handlingStatus: "RECEIVED" } }));
    await run(A, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { handlingStatus: "HANDLED", handlingCode: "status_recorded", handledAt: new Date() } }));
    await rejects(A, /handlingStatus transition HANDLED -> RECEIVED/, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { handlingStatus: "RECEIVED" } }));
    await rejects(A, /never deleted/, (tx) => tx.webhookEvent.delete({ where: { id: ev.id } }));
  });
});

describe("Phase 4 payment intake keeps working and can link to a webhook event", () => {
  const intake = (g: Graph, over: Record<string, unknown> = {}) => ({
    tenantId: g.tenantId, provider: "twilio", externalId: `pi-${Math.random().toString(36).slice(2, 10)}`, eventType: "payment.received", payloadHash: HASH,
    signatureValid: true, ...over,
  });

  it("an intake row without a webhook event (the Phase 4 route) is still valid", async () => {
    await run(A, (tx) => tx.paymentIntakeEvent.create({ data: intake(A) }));
  });

  it("links to one webhook event of the same tenant, once, and the link is frozen", async () => {
    const ev = await run(A, (tx) => tx.webhookEvent.create({ data: webhook(A, { eventType: "payment.received" }) }));
    const row = await run(A, (tx) => tx.paymentIntakeEvent.create({ data: intake(A, { webhookEventId: ev.id }) }));
    await rejects(A, /Unique constraint/, (tx) => tx.paymentIntakeEvent.create({ data: intake(A, { webhookEventId: ev.id }) }));
    await rejects(A, /foreign key/i, (tx) => tx.paymentIntakeEvent.create({ data: intake(A, { webhookEventId: B.webhookEventId }) }));
    await rejects(A, /immutable/, (tx) => tx.paymentIntakeEvent.update({ where: { id: row.id }, data: { webhookEventId: null } }));
    const plain = await run(A, (tx) => tx.paymentIntakeEvent.create({ data: intake(A) }));
    await rejects(A, /immutable/, (tx) => tx.paymentIntakeEvent.update({ where: { id: plain.id }, data: { webhookEventId: A.webhookEventId } }));
  });
});

describe("accounting mappings", () => {
  it("checks the mappings shape and secrets", async () => {
    const m = (over: Record<string, unknown>) => ({ tenantId: A.tenantId, version: 50 + Math.floor(Math.random() * 1000), mappings: [{ ledgerEntryType: "CHARGE" }], createdById: A.userId, ...over });
    await rejects(A, "accounting_mapping_mappings_shape", (tx) => tx.accountingMapping.create({ data: m({ mappings: [] }) }));
    await rejects(A, "accounting_mapping_mappings_shape", (tx) => tx.accountingMapping.create({ data: m({ mappings: { CHARGE: "4000" } }) }));
    await rejects(A, "accounting_mapping_mappings_shape", (tx) => tx.accountingMapping.create({ data: m({ mappings: [{ apiToken: "x" }] }) }));
    await rejects(A, "accounting_mapping_version_number", (tx) => tx.accountingMapping.create({ data: m({ version: 0 }) }));
  });

  it("versions are unique per legal entity series (NULL = tenant default)", async () => {
    await rejects(A, /accounting_mapping_version_unique/, (tx) =>
      tx.accountingMapping.create({ data: { tenantId: A.tenantId, legalEntityId: A.legalEntityId, version: 1, mappings: [{}], createdById: A.userId } }),
    );
    await run(A, (tx) => tx.accountingMapping.create({ data: { tenantId: A.tenantId, version: 1, mappings: [{}], createdById: A.userId } }));
    await rejects(A, /accounting_mapping_version_unique/, (tx) =>
      tx.accountingMapping.create({ data: { tenantId: A.tenantId, version: 1, mappings: [{}], createdById: A.userId } }),
    );
  });

  it("always needs an approval request; one ACTIVE per series; frozen once submitted", async () => {
    const now = new Date();
    await rejects(A, "accounting_mapping_needs_approval", (tx) =>
      tx.accountingMapping.create({ data: { tenantId: A.tenantId, version: 2, mappings: [{}], createdById: A.userId, status: "ACTIVE", activatedAt: now } }),
    );
    const request = await run(A, (tx) => approvalRequest(tx, A.tenantId, A.userId, "ACCOUNTING_MAPPING"));
    await rejects(A, "accounting_mapping_status_times", (tx) =>
      tx.accountingMapping.update({ where: { id: A.mappingId }, data: { status: "PENDING_APPROVAL", approvalRequestId: request.id } }),
    );
    await run(A, (tx) => tx.accountingMapping.update({ where: { id: A.mappingId }, data: { status: "PENDING_APPROVAL", approvalRequestId: request.id, submittedAt: now } }));
    await rejects(A, /frozen/, (tx) => tx.accountingMapping.update({ where: { id: A.mappingId }, data: { mappings: [{ ledgerEntryType: "REFUND" }] } }));
    await rejects(A, /status transition PENDING_APPROVAL -> RETIRED/, (tx) =>
      tx.accountingMapping.update({ where: { id: A.mappingId }, data: { status: "RETIRED", retiredAt: now } }),
    );
    await run(A, (tx) => tx.accountingMapping.update({ where: { id: A.mappingId }, data: { status: "ACTIVE", activatedAt: now } }));
    const request2 = await run(A, (tx) => approvalRequest(tx, A.tenantId, A.userId, "ACCOUNTING_MAPPING"));
    await rejects(A, /accounting_mapping_one_active/, (tx) =>
      tx.accountingMapping.create({
        data: { tenantId: A.tenantId, legalEntityId: A.legalEntityId, version: 2, mappings: [{}], createdById: A.userId, status: "ACTIVE", activatedAt: now, approvalRequestId: request2.id },
      }),
    );
    await rejects(A, /immutable/, (tx) => tx.accountingMapping.update({ where: { id: A.mappingId }, data: { legalEntityId: null } }));
    await rejects(A, /never deleted/, (tx) => tx.accountingMapping.delete({ where: { id: A.mappingId } }));
  });
});

describe("export batches", () => {
  it("checks period, content and kind shape (payroll carries no money)", async () => {
    await rejects(A, "export_batch_period", (tx) => tx.exportBatch.create({ data: payrollBatch(A, { periodEnd: new Date("2026-11-01") }) }));
    await rejects(A, "export_batch_period", (tx) => tx.exportBatch.create({ data: payrollBatch(A, { periodStart: new Date("2025-01-01"), periodEnd: new Date("2026-11-01") }) }));
    await rejects(A, "export_batch_content", (tx) => tx.exportBatch.create({ data: payrollBatch(A, { contentHash: "x".repeat(64) }) }));
    await rejects(A, "export_batch_content", (tx) => tx.exportBatch.create({ data: payrollBatch(A, { rowCount: -1 }) }));
    await rejects(A, "export_batch_kind_shape", (tx) => tx.exportBatch.create({ data: payrollBatch(A, { totals: { USD: { debit: "100", credit: "100" } } }) }));
    await rejects(A, "export_batch_kind_shape", (tx) => tx.exportBatch.create({ data: payrollBatch(A, { kind: "ACCOUNTING" }) }));
    await rejects(A, "export_batch_failure_code", (tx) => tx.exportBatch.create({ data: payrollBatch(A, { failureCode: "provider_down" }) }));
  });

  it("is idempotent per tenant key", async () => {
    const data = payrollBatch(A);
    await run(A, (tx) => tx.exportBatch.create({ data }));
    await rejects(A, /Unique constraint/, (tx) => tx.exportBatch.create({ data: { ...data } }));
  });

  it("releases a payroll batch only through an approval request; content is frozen", async () => {
    const batch = await run(A, (tx) => tx.exportBatch.create({ data: payrollBatch(A) }));
    await rejects(A, "export_batch_needs_approval", (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "APPROVED" } }));
    await rejects(A, "export_batch_needs_approval", (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "PENDING_APPROVAL" } }));
    const request = await run(A, (tx) => approvalRequest(tx, A.tenantId, A.userId, "PAYROLL_EXPORT"));
    await run(A, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "PENDING_APPROVAL", approvalRequestId: request.id } }));
    await run(A, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "APPROVED" } }));
    await rejects(A, "export_batch_exported", (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "EXPORTED" } }));
    await run(A, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "FAILED", failureCode: "provider_not_configured" } }));
    await run(A, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "APPROVED", failureCode: null } }));
    await run(A, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "EXPORTED", exportedAt: new Date(), exportedById: A.otherUserId } }));
    await rejects(A, /status transition EXPORTED -> CANCELLED/, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "CANCELLED" } }));
    await rejects(A, /immutable/, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { contentHash: HASH2 } }));
    await rejects(A, /immutable/, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { rowCount: 4 } }));
    await rejects(A, /never deleted/, (tx) => tx.exportBatch.delete({ where: { id: batch.id } }));
  });

  it("an accounting batch needs the ACTIVE mapping of its own series", async () => {
    const accounting = (over: Record<string, unknown>) =>
      payrollBatch(A, { kind: "ACCOUNTING", totals: { USD: { debit: "1000", credit: "1000" } }, legalEntityId: A.legalEntityId, ...over });
    const draft = await run(A, (tx) => tx.accountingMapping.create({ data: { tenantId: A.tenantId, legalEntityId: A.legalEntityId, version: 7, mappings: [{}], createdById: A.userId } }));
    await rejects(A, /needs an ACTIVE/, (tx) => tx.exportBatch.create({ data: accounting({ accountingMappingId: draft.id }) }));
    // A.mappingId was activated for A.legalEntityId above (accounting mappings suite).
    const otherEntity = await run(A, (tx) => tx.legalEntity.create({ data: { tenantId: A.tenantId, name: `Other LE ${suffix}` } }));
    await rejects(A, /another legal entity/, (tx) => tx.exportBatch.create({ data: accounting({ accountingMappingId: A.mappingId, legalEntityId: otherEntity.id }) }));
    const batch = await run(A, (tx) => tx.exportBatch.create({ data: accounting({ accountingMappingId: A.mappingId }) }));
    // No batch approval is required for accounting (the mapping was approved); it may go straight to APPROVED.
    await run(A, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { status: "APPROVED" } }));
    await rejects(A, /export_batch_not_own_supersede/, (tx) => tx.exportBatch.update({ where: { id: batch.id }, data: { supersedesBatchId: batch.id } }));
  });
});

describe("migration contract", () => {
  it("creates the partial and NULLS NOT DISTINCT unique indexes and the queue indexes", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set(rows.map((r) => r.indexname));
    for (const name of [
      "background_job_idempotency", "background_job_claimable", "background_job_running", "scheduled_job_definition_key", "domain_event_undispatched",
      "automation_rule_version_one_active", "AutomationExecution_tenantId_ruleVersionId_triggerEventId_key", "WebhookEvent_tenantId_provider_externalId_key",
      "accounting_mapping_version_unique", "accounting_mapping_one_active", "ExportBatch_tenantId_idempotencyKey_key", "PaymentIntakeEvent_webhookEventId_key",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("adds the Phase 7 approval subjects and enums", async () => {
    const values = async (type: string) =>
      (await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT unnest(enum_range(NULL::"${type}"))::text AS v`)).map((r) => r.v);
    expect(await values("ApprovalSubjectType")).toEqual(expect.arrayContaining(["AUTOMATION_RULE_VERSION", "ACCOUNTING_MAPPING", "PAYROLL_EXPORT"]));
    expect(await values("BackgroundJobStatus")).toEqual(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD"]);
    expect(await values("AutomationRuleStatus")).toEqual(["DRAFT", "PENDING_APPROVAL", "ACTIVE", "RETIRED"]);
    expect(await values("IntegrationStatus")).toEqual(["NOT_CONFIGURED", "CONNECTED", "ERROR", "DISABLED"]);
    expect(await values("IntegrationCategory")).toEqual([
      "MAPS", "NAVIGATION", "SMS", "EMAIL", "PUSH", "TELEPHONY", "PAYMENT", "PAYROLL", "ACCOUNTING", "MARKETING_LEAD_SOURCE", "EXTERNAL_CRM",
    ]);
  });
});
