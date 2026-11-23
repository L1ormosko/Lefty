import type { DispatchRecommendation } from "@prisma/client";
import type { RankedCandidate } from "@/lib/dispatch-scoring";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ConflictError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { assignJob, linkAssignmentToRecommendation } from "@/server/jobs";
import type { ApproveRecommendationInput, ModifyRecommendationInput, RejectRecommendationInput } from "./schemas";
import { authorizeOverJob, recommendationView, type RecommendationView } from "./views";

/**
 * The dispatcher's decision on a recommendation (§7.4): approve the top candidate, modify (choose someone
 * else, reason required) or reject. Every decision is stored on the recommendation (who, when, why, whom)
 * and audited; an accepted one becomes a real assignment through the jobs module, so hard eligibility,
 * override rights (`jobs.approve`) and notifications are exactly those of a manual assignment.
 *
 * Why three steps for approve / modify (the jobs module owns assignment and runs in its own transaction):
 *   1. read and validate the recommendation (must be PENDING);
 *   2. `assignJob` (method MANUAL, or OVERRIDE when an ineligible employee is chosen with an override);
 *   3. in a new transaction, re-lock the recommendation and stamp it decided, and stamp the assignment
 *      with the recommendation id and method (RECOMMENDATION_APPROVED / _MODIFIED, OVERRIDE is kept).
 * If the process stops between 2 and 3 the job IS assigned (the safe side) and the recommendation is still
 * PENDING: repeating the same decision skips step 2 (the employee already holds the job) and completes 3.
 */

type Decision = "APPROVED" | "MODIFIED" | "REJECTED";

async function loadPendingForDecision(tx: TenantTx, actor: Actor, recommendationId: string, lock: boolean): Promise<DispatchRecommendation> {
  await enforceInTx(tx, actor, "dispatch.assign");
  if (lock) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dispatch-decision:${recommendationId}`}))`;
  const row = await tx.dispatchRecommendation.findFirst({ where: { id: recommendationId, tenantId: actor.tenantId } });
  if (!row) throw new NotFoundError();
  await authorizeOverJob(tx, actor, "dispatch.assign", row.jobId);
  if (row.status !== "PENDING") {
    throw new InvalidStateTransitionError({ message: `This recommendation was already decided or replaced (status ${row.status}).` });
  }
  return row;
}

const candidatesOf = (row: DispatchRecommendation): RankedCandidate[] => row.candidates as unknown as RankedCandidate[];

/** Whether the employee already holds the job (step 2 already happened for this decision). */
async function alreadyHolds(tx: TenantTx, tenantId: string, jobId: string, employeeId: string): Promise<boolean> {
  return (await tx.jobAssignment.count({ where: { tenantId, jobId, employeeId, state: "ACTIVE" } })) > 0;
}

interface AcceptInput {
  decision: "APPROVED" | "MODIFIED";
  reason: string | undefined;
  override: { reason: string } | undefined;
}

/**
 * Steps 1-3 shared by approve and modify. `choose` picks (and validates) the employee from the pending
 * recommendation: the top candidate for approve, the requested one for modify.
 */
async function accept(
  actor: Actor,
  ctx: RequestContext,
  recommendationId: string,
  input: AcceptInput,
  choose: (row: DispatchRecommendation) => string,
): Promise<RecommendationView> {
  const pending = await withTenant(actor.tenantId, async (tx) => {
    const row = await loadPendingForDecision(tx, actor, recommendationId, false);
    const employeeId = choose(row);
    return { row, employeeId, alreadyAssigned: await alreadyHolds(tx, actor.tenantId, row.jobId, employeeId) };
  });
  const employeeId = pending.employeeId;

  if (!pending.alreadyAssigned) {
    await assignJob(actor, ctx, pending.row.jobId, { employeeId, reason: input.reason, override: input.override });
  }

  return withTenant(actor.tenantId, async (tx) => {
    const row = await loadPendingForDecision(tx, actor, recommendationId, true);
    const { method } = await linkAssignmentToRecommendation(tx, actor.tenantId, {
      jobId: row.jobId,
      employeeId: employeeId,
      recommendationId,
      method: input.decision === "APPROVED" ? "RECOMMENDATION_APPROVED" : "RECOMMENDATION_MODIFIED",
    });
    const candidates = candidatesOf(row);
    const chosenRank = candidates.find((candidate) => candidate.employeeId === employeeId)?.rank ?? null;
    const updated = await tx.dispatchRecommendation.update({
      where: { id: recommendationId },
      data: { status: input.decision, chosenEmployeeId: employeeId, decidedAt: new Date(), decidedById: actor.userId, decisionReason: input.reason ?? null },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: input.decision === "APPROVED" ? "dispatch.recommendation_approve" : "dispatch.recommendation_modify",
      targetType: "DispatchRecommendation",
      targetId: recommendationId,
      previousValue: { status: "PENDING", recommendedEmployeeId: candidates[0]?.employeeId ?? null },
      // §7.4: a departure from the recommendation is recorded with who, whom, which rank, whether an eligibility override was needed.
      newValue: { status: input.decision, chosenEmployeeId: employeeId, chosenRank, assignmentMethod: method, overrideUsed: method === "OVERRIDE" },
      reason: input.override?.reason ?? input.reason,
    });
    return recommendationView(updated);
  });
}

/**
 * Accepts the top-ranked candidate. Needs `dispatch.assign` over the job plus the jobs module's own checks
 * (`jobs.assign`; the hard eligibility is re-checked at this moment, so a candidate who became unavailable
 * since generation is refused with the reasons).
 * @throws ConflictError when the recommendation has no candidates ("no eligible technician").
 */
export async function approveRecommendation(actor: Actor, ctx: RequestContext, recommendationId: string, input: ApproveRecommendationInput): Promise<RecommendationView> {
  return accept(actor, ctx, recommendationId, { decision: "APPROVED", reason: input.reason, override: undefined }, (row) => {
    const top = candidatesOf(row)[0];
    if (!top) throw new ConflictError({ message: "There is no eligible technician to approve. Fix the blocking reasons or assign by hand." });
    return top.employeeId;
  });
}

/**
 * Chooses someone other than the top candidate (any employee: another candidate, or one outside the list).
 * The reason is required. If the choice fails the hard eligibility rules the request must carry an
 * `override` and the caller must hold `jobs.approve` (see jobs assignment); the assignment is then method
 * OVERRIDE and the override is recorded on the assignment, the job's events and the audit log.
 */
export async function modifyRecommendation(actor: Actor, ctx: RequestContext, recommendationId: string, input: ModifyRecommendationInput): Promise<RecommendationView> {
  return accept(actor, ctx, recommendationId, { decision: "MODIFIED", reason: input.reason, override: input.override }, (row) => {
    if (candidatesOf(row)[0]?.employeeId === input.employeeId) {
      throw new ValidationError({ message: "That employee is the recommended one: approve the recommendation instead.", field: "employeeId" });
    }
    return input.employeeId;
  });
}

/** Rejects the recommendation; the job stays pending and nobody is assigned. Needs `dispatch.assign`; the reason is required and kept. */
export async function rejectRecommendation(actor: Actor, ctx: RequestContext, recommendationId: string, input: RejectRecommendationInput): Promise<RecommendationView> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await loadPendingForDecision(tx, actor, recommendationId, true);
    const decision: Decision = "REJECTED";
    const updated = await tx.dispatchRecommendation.update({
      where: { id: recommendationId },
      data: { status: decision, decidedAt: new Date(), decidedById: actor.userId, decisionReason: input.reason },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "dispatch.recommendation_reject",
      targetType: "DispatchRecommendation",
      targetId: recommendationId,
      previousValue: { status: "PENDING", recommendedEmployeeId: candidatesOf(row)[0]?.employeeId ?? null },
      newValue: { status: decision },
      reason: input.reason,
    });
    return recommendationView(updated);
  });
}
