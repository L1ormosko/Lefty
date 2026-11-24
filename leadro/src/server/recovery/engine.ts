import { randomUUID } from "node:crypto";
import type { Prisma, WorkPriority } from "@prisma/client";
import {
  higherPriority,
  isInCooldown,
  matchConditions,
  validateRuleDefinition,
  type MatchResult,
  type PresenceValue,
  type RecoveryFacts,
  type RecoveryPriority,
  type RuleAction,
  type RuleDefinition,
} from "@/lib/recovery-rules";
import { recordAudit } from "@/server/audit";
import { nextNumber } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { createFollowUpTaskInTx } from "@/server/follow-ups";
import { logger } from "@/server/logging";
import { onJobOutcomeRecorded, type OutcomeRecordedEvent } from "@/server/job-outcomes";
import { notifyCaseCreated } from "./notify";
import { evaluatePresence, type PresenceSnapshot } from "./presence";

/**
 * The recovery engine (§9.3, §9.6). It subscribes to `job.not_converted` (via `onJobOutcomeRecorded`), which runs INSIDE the
 * transaction that records the visit outcome. Two consequences drive the design:
 *
 *  - It must NEVER throw: a failing subscriber would roll the technician's outcome back. The whole handler and every rule run
 *    inside a SAVEPOINT; a failure rolls back to it, is logged, and (for a rule) leaves a `RecoveryRuleRun` with
 *    `skippedReason = "error"` so the failure is visible and the outcome still commits.
 *  - It must be fast: rules are loaded once, presence is evaluated once, each rule is one small transaction fragment.
 *
 * Loop safety: `(tenant, rule, outcome)` is unique in `RecoveryRuleRun`, so re-running the engine for an outcome never fires
 * a rule twice; a rule also respects its cooldown per customer (`isInCooldown`); actions create no job outcomes, so a case
 * cannot trigger itself. There is no discount action (§9.6).
 */

const HANDLER_NAME = "lead-recovery-engine";
const RECOVERY_FOLLOW_UP_TITLE = "Recovery: call the customer about the lost visit";

interface OutcomeContext {
  outcomeId: string;
  jobId: string;
  jobNumber: number;
  customerId: string;
  leadId: string | null;
  orgUnitId: string;
  jobTypeId: string;
  technicianId: string | null;
  outcome: string;
  lostReasonId: string | null;
  lostReasonRecoverable: boolean | null;
  valueMinor: number | null;
  currency: string;
  customerRequestedFollowUp: boolean;
  occurredAt: Date;
}

/** Loads the facts of one outcome (ids, enums, numbers). */
export async function loadOutcomeContext(tx: TenantTx, tenantId: string, outcomeId: string): Promise<OutcomeContext | null> {
  const row = await tx.jobOutcome.findFirst({
    where: { id: outcomeId, tenantId },
    select: {
      id: true,
      jobId: true,
      outcome: true,
      lostReasonId: true,
      employeeId: true,
      quotedAmountMinor: true,
      approvedAmountMinor: true,
      currency: true,
      customerRequestedFollowUp: true,
      occurredAt: true,
      lostReason: { select: { recoverable: true } },
      job: { select: { number: true, customerId: true, leadId: true, orgUnitId: true, jobTypeId: true } },
    },
  });
  if (!row) return null;
  return {
    outcomeId: row.id,
    jobId: row.jobId,
    jobNumber: row.job.number,
    customerId: row.job.customerId,
    leadId: row.job.leadId,
    orgUnitId: row.job.orgUnitId,
    jobTypeId: row.job.jobTypeId,
    technicianId: row.employeeId,
    outcome: row.outcome,
    lostReasonId: row.lostReasonId,
    lostReasonRecoverable: row.lostReason?.recoverable ?? null,
    valueMinor: row.quotedAmountMinor ?? row.approvedAmountMinor ?? null,
    currency: row.currency,
    customerRequestedFollowUp: row.customerRequestedFollowUp,
    occurredAt: row.occurredAt,
  };
}

export const factsOf = (context: OutcomeContext, presence: PresenceValue): RecoveryFacts => ({
  outcome: context.outcome,
  lostReasonId: context.lostReasonId,
  lostReasonRecoverable: context.lostReasonRecoverable,
  jobTypeId: context.jobTypeId,
  valueMinor: context.valueMinor,
  presence,
  customerRequestedFollowUp: context.customerRequestedFollowUp,
});

/** The org unit and its ancestors, nearest first: a rule scoped to any of them applies to the job. */
export async function unitAndAncestors(tx: TenantTx, tenantId: string, orgUnitId: string): Promise<string[]> {
  const chain: string[] = [];
  let current: string | null = orgUnitId;
  while (current && chain.length < 30 && !chain.includes(current)) {
    chain.push(current);
    const parent: { parentId: string | null } | null = await tx.orgUnit.findFirst({ where: { id: current, tenantId }, select: { parentId: true } });
    current = parent?.parentId ?? null;
  }
  return chain;
}

interface ActiveRule {
  id: string;
  ruleKey: string;
  version: number;
  cooldownMinutes: number;
  definition: RuleDefinition;
}

async function loadActiveRules(tx: TenantTx, tenantId: string, trigger: string, unitChain: string[]): Promise<ActiveRule[]> {
  const rows = await tx.recoveryRule.findMany({
    where: { tenantId, status: "ACTIVE", trigger, OR: [{ orgUnitId: null }, { orgUnitId: { in: unitChain } }] },
    orderBy: [{ priority: "asc" }, { ruleKey: "asc" }],
    select: { id: true, ruleKey: true, version: true, cooldownMinutes: true, trigger: true, conditions: true, actions: true },
  });
  const rules: ActiveRule[] = [];
  for (const row of rows) {
    const parsed = validateRuleDefinition(row);
    // A stored rule that no longer validates (vocabulary changed) is skipped, not fatal.
    if (parsed.ok) rules.push({ id: row.id, ruleKey: row.ruleKey, version: row.version, cooldownMinutes: row.cooldownMinutes, definition: parsed.definition });
  }
  return rules;
}

/** The latest run of any version of `ruleKey` for the customer that actually did something (cooldown anchor). */
async function lastFiredAt(tx: TenantTx, tenantId: string, ruleKey: string, customerId: string): Promise<Date | null> {
  const run = await tx.recoveryRuleRun.findFirst({
    where: { tenantId, customerId, matched: true, skippedReason: null, rule: { ruleKey } },
    orderBy: { firedAt: "desc" },
    select: { firedAt: true },
  });
  return run?.firedAt ?? null;
}

interface CaseState {
  id: string;
  number: number;
  priority: RecoveryPriority;
  priorityScore: number | null;
  recommendation: string | null;
  assignedToId: string | null;
}

async function findCase(tx: TenantTx, tenantId: string, outcomeId: string): Promise<CaseState | null> {
  const row = await tx.leadRecoveryCase.findFirst({
    where: { tenantId, jobOutcomeId: outcomeId },
    select: { id: true, number: true, priority: true, priorityScore: true, recommendation: true, assignedToId: true },
  });
  return row;
}

export interface ActionResult {
  /** Codes of the actions that changed something (`RecoveryRuleRun.actionsTaken`). */
  taken: string[];
  caseId: string | null;
  skippedReason: string | null;
}

/**
 * Applies one rule's actions to the outcome's case (creating it when the rule says so). The order is fixed: case first, then
 * priority, recommendation, follow-up, notification, so every later action sees the case.
 */
async function applyActions(
  tx: TenantTx,
  tenantId: string,
  rule: ActiveRule,
  context: OutcomeContext,
  presence: PresenceSnapshot,
): Promise<ActionResult> {
  const taken: string[] = [];
  let state = await findCase(tx, tenantId, context.outcomeId);
  const byType = (type: RuleAction["type"]) => rule.definition.actions.filter((action) => action.type === type);

  const createAction = byType("create_case")[0];
  if (createAction && createAction.type === "create_case" && !state) {
    const id = randomUUID();
    const number = await nextNumber(tx, tenantId, "recovery_case");
    const priority = createAction.priority ?? "NORMAL";
    await tx.leadRecoveryCase.create({
      data: {
        id,
        tenantId,
        number,
        jobOutcomeId: context.outcomeId,
        jobId: context.jobId,
        customerId: context.customerId,
        leadId: context.leadId,
        technicianId: context.technicianId,
        orgUnitId: context.orgUnitId,
        lostReasonId: context.lostReasonId,
        status: "NEW",
        priority,
        ruleId: rule.id,
        ruleVersion: rule.version,
        outcomeAt: context.occurredAt,
        presenceStatus: presence.status,
        presenceEvaluatedAt: presence.evaluatedAt,
        presenceLocationEventId: presence.locationEventId,
        presenceAccuracyM: presence.accuracyM,
        presenceDistanceM: presence.distanceM,
        presenceReason: presence.reason,
        initialValueMinor: context.valueMinor,
        // The quote is the starting ESTIMATE of what recovery could bring in. It is never confirmed revenue (§9.7).
        estimatedValueMinor: context.valueMinor,
        currency: context.currency,
      },
    });
    await tx.recoveryCaseStatusHistory.create({
      data: { tenantId, caseId: id, fromStatus: null, toStatus: "NEW", actorType: "SYSTEM", reason: `rule:${rule.ruleKey}@${rule.version}` },
    });
    await recordAudit(tx, {
      tenantId,
      actorUserId: null,
      sourceApp: "SYSTEM",
      action: "recovery.case_create",
      targetType: "LeadRecoveryCase",
      targetId: id,
      // Ids, enums and codes only: no coordinates, no names, no amounts.
      newValue: { number, jobId: context.jobId, jobOutcomeId: context.outcomeId, ruleId: rule.id, ruleVersion: rule.version, presenceStatus: presence.status, priority },
    });
    state = { id, number, priority: priority as RecoveryPriority, priorityScore: null, recommendation: null, assignedToId: null };
    taken.push("create_case");
  }
  if (!state) return { taken, caseId: null, skippedReason: "no_case" };

  const patch: Prisma.LeadRecoveryCaseUncheckedUpdateInput = {};
  for (const action of byType("set_priority")) {
    if (action.type !== "set_priority") continue;
    const next = higherPriority(state.priority, action.priority);
    if (next !== state.priority) {
      patch.priority = next as WorkPriority;
      state.priority = next;
    }
    if (action.score !== undefined && (state.priorityScore === null || action.score > state.priorityScore)) {
      patch.priorityScore = action.score;
      state.priorityScore = action.score;
    }
    taken.push("set_priority");
  }
  for (const action of byType("recommend")) {
    // Rules run in priority order, so the first recommendation (the most important rule's) stands.
    if (action.type === "recommend" && state.recommendation === null) {
      patch.recommendation = action.code;
      state.recommendation = action.code;
      taken.push("recommend");
    }
  }
  if (Object.keys(patch).length > 0) {
    await tx.leadRecoveryCase.update({ where: { id: state.id }, data: patch });
    await recordAudit(tx, { tenantId, actorUserId: null, sourceApp: "SYSTEM", action: "recovery.case_annotate", targetType: "LeadRecoveryCase", targetId: state.id, newValue: { ruleId: rule.id, ...patch } });
  }

  for (const action of byType("create_follow_up")) {
    if (action.type !== "create_follow_up") continue;
    const result = await createFollowUpTaskInTx(
      tx,
      { tenantId, system: true },
      {
        targetType: "RECOVERY_CASE",
        targetId: state.id,
        title: RECOVERY_FOLLOW_UP_TITLE,
        dueAt: new Date(Date.now() + action.dueInMinutes * 60_000),
        priority: (action.priority ?? state.priority) as WorkPriority,
        origin: "RECOVERY_RULE",
        dedupeKey: `recovery:${state.id}:${rule.id}`,
      },
    );
    if (result.created) taken.push("create_follow_up");
  }
  if (byType("notify").length > 0) {
    const notified = await notifyCaseCreated(tx, tenantId, { caseId: state.id, caseNumber: state.number, orgUnitId: context.orgUnitId, ruleId: rule.id });
    if (notified > 0) taken.push("notify");
  }
  return { taken, caseId: state.id, skippedReason: taken.length === 0 ? "nothing_to_do" : null };
}

async function recordRun(
  tx: TenantTx,
  tenantId: string,
  rule: ActiveRule,
  context: OutcomeContext,
  run: { matched: boolean; actionsTaken: string[]; skippedReason: string | null; caseId: string | null },
): Promise<void> {
  await tx.recoveryRuleRun.create({
    data: {
      tenantId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      jobOutcomeId: context.outcomeId,
      customerId: context.customerId,
      matched: run.matched,
      actionsTaken: run.actionsTaken,
      skippedReason: run.skippedReason,
      recoveryCaseId: run.caseId,
    },
  });
}

async function evaluateRule(tx: TenantTx, tenantId: string, rule: ActiveRule, context: OutcomeContext, presence: PresenceSnapshot, now: Date): Promise<void> {
  const existing = await tx.recoveryRuleRun.findFirst({ where: { tenantId, ruleId: rule.id, jobOutcomeId: context.outcomeId }, select: { id: true } });
  if (existing) return; // already evaluated (idempotent)
  const match = matchConditions(rule.definition.conditions, factsOf(context, presence.status));
  if (!match.matched) {
    await recordRun(tx, tenantId, rule, context, { matched: false, actionsTaken: [], skippedReason: "conditions_not_met", caseId: null });
    return;
  }
  if (isInCooldown(rule.cooldownMinutes, await lastFiredAt(tx, tenantId, rule.ruleKey, context.customerId), now)) {
    await recordRun(tx, tenantId, rule, context, { matched: true, actionsTaken: [], skippedReason: "cooldown", caseId: null });
    return;
  }
  const result = await applyActions(tx, tenantId, rule, context, presence);
  await recordRun(tx, tenantId, rule, context, { matched: true, actionsTaken: result.taken, skippedReason: result.skippedReason, caseId: result.caseId });
}

/** Runs `work` inside a savepoint; on failure rolls back to it and returns the error instead of throwing. */
async function guarded(tx: TenantTx, name: string, work: () => Promise<void>): Promise<unknown | null> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    await work();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return null;
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    return error ?? new Error("unknown failure");
  }
}

/**
 * The subscriber: evaluates the tenant's ACTIVE rules for one not-converted visit. Never throws (see the file comment).
 * Exported for tests; production code calls `registerRecoveryEngine()`.
 */
export async function handleOutcomeRecorded(tx: TenantTx, event: OutcomeRecordedEvent): Promise<void> {
  if (!event.notConverted) return;
  const { tenantId } = event;
  try {
    const failure = await guarded(tx, "recovery_engine", async () => {
      const context = await loadOutcomeContext(tx, tenantId, event.outcomeId);
      if (!context) return;
      const rules = await loadActiveRules(tx, tenantId, "job.not_converted", await unitAndAncestors(tx, tenantId, context.orgUnitId));
      if (rules.length === 0) return;
      const now = new Date();
      const presence = await evaluatePresence(tx, tenantId, { technicianId: context.technicianId, jobId: context.jobId, now });
      for (const rule of rules) {
        const error = await guarded(tx, "recovery_rule", () => evaluateRule(tx, tenantId, rule, context, presence, now));
        if (error === null) continue;
        logger.error("recovery rule failed", { tenantId, ruleId: rule.id, outcomeId: event.outcomeId, error: error instanceof Error ? error.message : String(error) });
        // The failure stays visible: a run with skippedReason "error" (best effort; never fatal).
        const recorded = await guarded(tx, "recovery_rule_error", () => recordRun(tx, tenantId, rule, context, { matched: false, actionsTaken: [], skippedReason: "error", caseId: null }));
        if (recorded !== null) logger.error("recovery error run not recorded", { tenantId, ruleId: rule.id });
      }
    });
    if (failure !== null) logger.error("recovery engine failed", { tenantId, outcomeId: event.outcomeId, error: failure instanceof Error ? failure.message : String(failure) });
  } catch (error) {
    // Even the savepoint statements failed (connection trouble): the transaction is beyond saving here; do not add to it.
    logger.error("recovery engine could not run", { tenantId, outcomeId: event.outcomeId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Subscribes the engine to recorded outcomes. Idempotent (same handler name replaces itself). */
export function registerRecoveryEngine(): void {
  onJobOutcomeRecorded(HANDLER_NAME, handleOutcomeRecorded);
}
