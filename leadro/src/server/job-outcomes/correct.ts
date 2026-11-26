import type { Prisma } from "@prisma/client";
import { outcomeProblem } from "@/lib/job-outcome-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx, projectFields } from "@/server/authz";
import { ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { jobResourceRef, lockJob, recordJobEvent } from "@/server/jobs";
import { publishOutcomeCorrected } from "./events";
import { decisionHoldsFinancial } from "./financial";
import { OUTCOME_FIELD_MAP, OUTCOME_FINANCIAL_KEYS, outcomeRowSelect } from "./fields";
import type { CorrectOutcomeInput } from "./schemas";

const refusal = (field: string, code: string, message: string): ValidationError =>
  new ValidationError({ message, field, details: [{ field, code, message }] });

/**
 * Correcting a recorded outcome (§9.1, `job_outcomes.edit`: managers, not the technician who reported it).
 * The outcome type is fixed: the job status already followed it, and a different result is a different visit.
 * What can change: the reason, notes, amounts, payment and the follow-up request; amounts and payment need the
 * `financial` field set. Every change keeps the cross-field rules (reason / money / payment), keeps the job's currency,
 * and is audited with the FULL previous and new value of each changed field (§25.4: a financial correction never
 * loses the original; read it back with `getOutcomeCorrections`).
 */
export async function correctJobOutcome(actor: Actor, ctx: RequestContext, outcomeId: string, input: CorrectOutcomeInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const tenantId = actor.tenantId;
    const found = await tx.jobOutcome.findFirst({ where: { id: outcomeId, tenantId }, select: { jobId: true } });
    if (!found) throw new NotFoundError();
    await lockJob(tx, tenantId, found.jobId);
    const resource = await jobResourceRef(tx, tenantId, found.jobId);
    if (!resource) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "job_outcomes.edit", resource);

    const current = await tx.jobOutcome.findFirstOrThrow({ where: { id: outcomeId, tenantId }, select: outcomeRowSelect });
    const { reason, ...rest } = input;
    const changes = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    const changedKeys = Object.keys(changes);

    const touchesMoney = changedKeys.filter((key) => OUTCOME_FINANCIAL_KEYS.includes(key));
    if (touchesMoney.length > 0 && !decisionHoldsFinancial(decision)) {
      throw new ForbiddenError({ message: "Your access does not include outcome amounts or payment.", field: touchesMoney[0] });
    }
    // The currency is the job's; it is not a thing a correction chooses, so alone it changes nothing meaningful.
    const jobCurrency = (await tx.job.findFirstOrThrow({ where: { id: found.jobId, tenantId }, select: { currency: true } })).currency;
    if (input.currency !== undefined && input.currency !== jobCurrency) throw refusal("currency", "job_outcome.currency_mismatch", "The outcome currency must be the job's currency.");
    if (changedKeys.length === 1 && changedKeys[0] === "currency") throw refusal("currency", "job_outcome.currency_alone", "The currency cannot be corrected on its own.");

    const next = { ...current, ...changes } as typeof current;
    const problem = outcomeProblem({
      outcome: next.outcome,
      hasLostReason: next.lostReasonId !== null,
      quotedAmountMinor: next.quotedAmountMinor,
      approvedAmountMinor: next.approvedAmountMinor,
      chargedAmountMinor: next.chargedAmountMinor,
      collectedAmountMinor: next.collectedAmountMinor,
      paymentMethod: next.paymentMethod,
      paymentStatus: next.paymentStatus,
    });
    if (problem) throw refusal(problem.field, `job_outcome.${problem.code.toLowerCase()}`, `Invalid outcome: ${problem.code}.`);
    if (input.lostReasonId && input.lostReasonId !== current.lostReasonId) {
      const lostReason = await tx.lostReason.findFirst({ where: { id: input.lostReasonId, tenantId }, select: { active: true, appliesTo: true } });
      if (!lostReason?.active || !lostReason.appliesTo.includes(current.outcome)) {
        throw refusal("lostReasonId", "job_outcome.lost_reason_not_applicable", "Choose an active lost reason that applies to this outcome.");
      }
    }

    const updated = await tx.jobOutcome.update({ where: { id: outcomeId }, data: changes as Prisma.JobOutcomeUncheckedUpdateInput, select: outcomeRowSelect });
    const previousValues = Object.fromEntries(changedKeys.map((key) => [key, jsonSafe((current as Record<string, unknown>)[key])]));
    const newValues = Object.fromEntries(changedKeys.map((key) => [key, jsonSafe((updated as Record<string, unknown>)[key])]));
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "job_outcome.correct",
      targetType: "JobOutcome",
      targetId: outcomeId,
      previousValue: { changedFields: changedKeys.sort(), values: previousValues },
      newValue: { changedFields: changedKeys, values: newValues },
      reason,
    });
    const jobEventId = await recordJobEvent(tx, tenantId, found.jobId, { type: "job.outcome_corrected", actor, payload: { outcomeId, changedFields: changedKeys } });
    await publishOutcomeCorrected(tx, { tenantId, jobId: found.jobId, outcomeId, jobEventId, changedFields: changedKeys, actorUserId: actor.userId });
    return projectFields(updated, decision, OUTCOME_FIELD_MAP);
  });
}

/** Dates become ISO strings so the audit JSON column can hold them. */
const jsonSafe = (value: unknown): Prisma.InputJsonValue | null => (value instanceof Date ? value.toISOString() : ((value ?? null) as Prisma.InputJsonValue | null));

export interface OutcomeCorrectionView {
  at: Date;
  byUserId: string | null;
  reason: string | null;
  changedFields: string[];
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}

/**
 * The correction history of an outcome, oldest first, with the previous and new value of every changed field (§25.4).
 * Needs `job_outcomes.edit` over the job AND its `financial` field set (the history holds amounts). Fields outside the
 * caller's sets cannot appear: a caller without `financial` is refused rather than shown a filtered history.
 */
export async function getOutcomeCorrections(actor: Actor, outcomeId: string): Promise<OutcomeCorrectionView[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const found = await tx.jobOutcome.findFirst({ where: { id: outcomeId, tenantId: actor.tenantId }, select: { jobId: true } });
    if (!found) throw new NotFoundError();
    const resource = await jobResourceRef(tx, actor.tenantId, found.jobId);
    if (!resource) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "job_outcomes.edit", resource);
    if (!decisionHoldsFinancial(decision)) throw new ForbiddenError({ message: "Your access does not include outcome amounts or payment." });

    const rows = await tx.auditEvent.findMany({
      where: { tenantId: actor.tenantId, action: "job_outcome.correct", targetId: outcomeId },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      select: { occurredAt: true, actorUserId: true, reason: true, previousValue: true, newValue: true },
    });
    const valuesOf = (json: unknown): { changedFields: string[]; values: Record<string, unknown> } => {
      const object = (json ?? {}) as { changedFields?: string[]; values?: Record<string, unknown> };
      return { changedFields: object.changedFields ?? [], values: object.values ?? {} };
    };
    return rows.map((row) => ({
      at: row.occurredAt,
      byUserId: row.actorUserId,
      reason: row.reason,
      changedFields: valuesOf(row.newValue).changedFields,
      previous: valuesOf(row.previousValue).values,
      next: valuesOf(row.newValue).values,
    }));
  });
}
