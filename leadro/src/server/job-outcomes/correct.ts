import type { Prisma } from "@prisma/client";
import { outcomeProblem } from "@/lib/job-outcome-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx, projectFields } from "@/server/authz";
import { NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { jobResourceRef, lockJob, recordJobEvent } from "@/server/jobs";
import { OUTCOME_FIELD_MAP, outcomeRowSelect } from "./fields";
import type { CorrectOutcomeInput } from "./schemas";

/**
 * Correcting a recorded outcome (§9.1, `job_outcomes.edit`: managers, not the technician who reported it).
 * The outcome type is fixed: the job status already followed it, and a different result is a different visit.
 * What can change: the reason, notes, amounts, payment and the follow-up request. Every change keeps the
 * cross-field rules (reason / money / payment), is audited with the changed field NAMES and the correction
 * reason, and appears in the job's event log.
 */
export async function correctJobOutcome(actor: Actor, ctx: RequestContext, outcomeId: string, input: CorrectOutcomeInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const tenantId = actor.tenantId;
    const found = await tx.jobOutcome.findFirst({ where: { id: outcomeId, tenantId }, select: { jobId: true } });
    if (!found) throw new NotFoundError();
    await lockJob(tx, tenantId, found.jobId);
    const resource = await jobResourceRef(tx, tenantId, found.jobId);
    if (!resource) throw new NotFoundError();
    await enforceInTx(tx, actor, "job_outcomes.edit", resource);

    const current = await tx.jobOutcome.findFirstOrThrow({ where: { id: outcomeId, tenantId }, select: outcomeRowSelect });
    const { reason, ...changes } = input;
    const next = { ...current, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) } as typeof current;

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
    if (problem) {
      throw new ValidationError({
        message: `Invalid outcome: ${problem.code}.`,
        field: problem.field,
        details: [{ field: problem.field, code: `job_outcome.${problem.code.toLowerCase()}`, message: `Invalid outcome: ${problem.code}.` }],
      });
    }
    if (changes.lostReasonId && changes.lostReasonId !== current.lostReasonId) {
      const lostReason = await tx.lostReason.findFirst({ where: { id: changes.lostReasonId, tenantId }, select: { active: true, appliesTo: true } });
      if (!lostReason?.active || !lostReason.appliesTo.includes(current.outcome)) {
        throw new ValidationError({
          message: "Choose an active lost reason that applies to this outcome.",
          field: "lostReasonId",
          details: [{ field: "lostReasonId", code: "job_outcome.lost_reason_not_applicable", message: "Choose an active lost reason that applies to this outcome." }],
        });
      }
    }

    const data = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Prisma.JobOutcomeUncheckedUpdateInput;
    const updated = await tx.jobOutcome.update({ where: { id: outcomeId }, data, select: outcomeRowSelect });
    const changedFields = Object.keys(data).sort();
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "job_outcome.correct",
      targetType: "JobOutcome",
      targetId: outcomeId,
      previousValue: { outcome: current.outcome },
      newValue: { changedFields },
      reason,
    });
    await recordJobEvent(tx, tenantId, found.jobId, { type: "job.outcome_corrected", actor, payload: { outcomeId, changedFields } });
    return projectFields(updated, { allowed: true, fieldSets: ["base"] }, OUTCOME_FIELD_MAP);
  });
}
