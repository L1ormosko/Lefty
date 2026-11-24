import { isHighImpact, isInCooldown, matchConditions, validateRuleDefinition, type RuleDefinition } from "@/lib/recovery-rules";
import { canInTx, enforceInTx } from "@/server/authz";
import { jobResourceRef } from "@/server/jobs";
import { NotFoundError, ValidationError, type Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import { assertRuleAccess } from "./access";
import { evaluatePresence } from "./presence";
import { factsOf, loadOutcomeContext } from "./engine";
import type { DryRunInput } from "./schemas";

/**
 * Dry run (§9.6 "testable"): evaluates a stored rule or an unsaved definition against a REAL not-converted outcome and says
 * what the engine would do and why. Nothing is written: no run row, no case, no notification, no audit event (dry runs are
 * not stored). The outcome must be one the caller may manage recovery for (`recovery.manage` over the job's service area).
 */
export async function dryRunRule(actor: Actor, input: DryRunInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "recovery.manage");
    const context = await loadOutcomeContext(tx, actor.tenantId, input.jobOutcomeId);
    if (!context) throw new NotFoundError();
    await enforceInTx(tx, actor, "recovery.manage", { orgUnitId: context.orgUnitId });
    if (context.outcome !== "NOT_SOLD" && context.outcome !== "WORK_NOT_POSSIBLE") {
      throw new ValidationError({ message: "Only a not-converted visit outcome can be tested.", field: "jobOutcomeId" });
    }

    let definition: RuleDefinition;
    let cooldownMinutes: number;
    let ruleKey: string | null = null;
    if (input.ruleId) {
      const rule = await assertRuleAccess(tx, actor, input.ruleId, "recovery.view");
      const parsed = validateRuleDefinition(rule);
      if (!parsed.ok) throw new ValidationError({ message: "The stored rule no longer validates.", field: "ruleId" });
      definition = parsed.definition;
      cooldownMinutes = rule.cooldownMinutes;
      ruleKey = rule.ruleKey;
    } else {
      const supplied = input.definition!;
      const parsed = validateRuleDefinition(supplied);
      if (!parsed.ok) throw new ValidationError({ message: parsed.problems.map((problem) => `${problem.path}: ${problem.message}`).join("; "), field: parsed.problems[0]?.path });
      definition = parsed.definition;
      cooldownMinutes = supplied.cooldownMinutes;
    }

    // The visit's quote is outcome money: Lead Ops see it only with the outcome financial set over this job (the outcomes ruling).
    const jobRef = await jobResourceRef(tx, actor.tenantId, context.jobId);
    const outcomeView = jobRef ? await canInTx(tx, actor, "job_outcomes.view", jobRef) : null;
    const mayReadMoney = Boolean(outcomeView?.allowed && outcomeView.fieldSets.includes("financial"));
    const now = new Date();
    const presence = await evaluatePresence(tx, actor.tenantId, { technicianId: context.technicianId, jobId: context.jobId, now });
    const presenceUsed = input.presence ?? presence.status;
    const match = matchConditions(definition.conditions, factsOf(context, presenceUsed));
    const existingCase = await tx.leadRecoveryCase.findFirst({ where: { tenantId: actor.tenantId, jobOutcomeId: context.outcomeId }, select: { id: true } });
    const lastRun = ruleKey
      ? await tx.recoveryRuleRun.findFirst({
          where: { tenantId: actor.tenantId, customerId: context.customerId, matched: true, skippedReason: null, rule: { ruleKey } },
          orderBy: { firedAt: "desc" },
          select: { firedAt: true },
        })
      : null;
    const inCooldown = isInCooldown(cooldownMinutes, lastRun?.firedAt ?? null, now);
    const wouldFire = match.matched && !inCooldown;

    return {
      matched: match.matched,
      wouldFire,
      skippedReason: !match.matched ? "conditions_not_met" : inCooldown ? "cooldown" : null,
      checks: match.checks.map((check) =>
        !mayReadMoney && (check.condition === "minValueMinor" || check.condition === "maxValueMinor") ? { ...check, actual: null, redacted: true } : check,
      ),
      cooldown: { cooldownMinutes, inCooldown },
      // Presence is shown as a status with its reason, never as a position.
      presence: { status: presence.status, reason: presence.reason, accuracyM: presence.accuracyM, overridden: input.presence !== undefined },
      existingCaseId: existingCase?.id ?? null,
      highImpact: isHighImpact(definition.actions),
      // What would happen, as codes (no discount action exists).
      actions: wouldFire ? definition.actions.map((action) => ({ ...action })) : [],
      stored: false,
    };
  });
}
