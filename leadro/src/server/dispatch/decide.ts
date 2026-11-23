import type { DispatchRecommendation } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ConflictError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { assignJobInTx, lockJob } from "@/server/jobs";
import { deliverAfterCommit } from "@/server/notifications";
import type { ApproveRecommendationInput, ModifyRecommendationInput, RejectRecommendationInput } from "./schemas";
import { authorizeOverJob, storedCandidates, viewRecommendationsFor, visibleEmployeeIdSet, type RecommendationView } from "./views";

/**
 * The dispatcher's decision on a recommendation (§7.4): approve the top candidate, modify (choose someone
 * else, reason required) or reject. Every decision is stored on the recommendation (who, when, why, whom)
 * and audited; an accepted one becomes a real assignment through the jobs module's own `assignJobInTx`, so hard
 * eligibility, override rights (`jobs.approve`), employee scope and notifications are exactly those of a manual assignment.
 *
 * ONE TRANSACTION per decision, serialised by the JOB's row lock (the same lock `assignJob` takes), so two decisions, or a
 * decision and a manual assignment, on the same job queue up and the later one sees the earlier one's result:
 *   1. lock the job, re-read the recommendation under the lock and require it to be PENDING (this is the claim: a
 *      concurrent approve / modify / reject finds it already decided; a manual assignment has superseded it);
 *   2. staleness check: if any assignment of the job was created or ended after the recommendation was generated, it
 *      describes a situation that no longer exists: `409` with detail code STALE_RECOMMENDATION, generate a new one;
 *   3. assign (method RECOMMENDATION_APPROVED / _MODIFIED, or OVERRIDE), stamp the recommendation, audit.
 * Nothing is half-done: if anything fails the recommendation stays PENDING and no assignment exists.
 */

/** Claims the recommendation: job lock first (lock order job > recommendation), then a fresh read that must be PENDING. */
async function claimPending(tx: TenantTx, actor: Actor, recommendationId: string, requireFresh: boolean): Promise<DispatchRecommendation> {
  await enforceInTx(tx, actor, "dispatch.assign");
  const peek = await tx.dispatchRecommendation.findFirst({ where: { id: recommendationId, tenantId: actor.tenantId }, select: { jobId: true } });
  if (!peek) throw new NotFoundError();
  if (!(await lockJob(tx, actor.tenantId, peek.jobId))) throw new NotFoundError();
  const row = await tx.dispatchRecommendation.findFirst({ where: { id: recommendationId, tenantId: actor.tenantId } });
  if (!row) throw new NotFoundError();
  await authorizeOverJob(tx, actor, "dispatch.assign", row.jobId);
  if (row.status !== "PENDING") {
    throw new InvalidStateTransitionError({ message: `This recommendation was already decided or replaced (status ${row.status}).` });
  }
  if (requireFresh) await assertNotStale(tx, actor.tenantId, row);
  return row;
}

/** Any assignment of the job created or ended since the recommendation was generated makes it stale. */
async function assertNotStale(tx: TenantTx, tenantId: string, row: DispatchRecommendation): Promise<void> {
  const changed = await tx.jobAssignment.count({
    where: { tenantId, jobId: row.jobId, OR: [{ assignedAt: { gt: row.generatedAt } }, { endedAt: { gt: row.generatedAt } }] },
  });
  if (changed > 0) {
    throw new ConflictError({
      message: "The job's assignment changed after this recommendation was generated. Generate a new recommendation and decide again.",
      field: "recommendation",
      details: [{ field: "recommendation", code: "STALE_RECOMMENDATION", message: "Generate a new recommendation." }],
    });
  }
}

interface AcceptInput {
  decision: "APPROVED" | "MODIFIED";
  reason: string | undefined;
  override: { reason: string } | undefined;
}

/** The shared body of approve and modify. `choose` picks (and validates) the employee from the claimed recommendation. */
async function accept(
  actor: Actor,
  ctx: RequestContext,
  recommendationId: string,
  input: AcceptInput,
  choose: (row: DispatchRecommendation, visible: ReadonlySet<string>) => string,
): Promise<RecommendationView> {
  const notificationIds: string[] = [];
  const view = await withTenant(actor.tenantId, async (tx) => {
    const row = await claimPending(tx, actor, recommendationId, true);
    const candidates = storedCandidates(row).ranked;
    const employeeId = choose(row, await visibleEmployeeIdSet(tx, actor, candidates.map((candidate) => candidate.employeeId)));

    const { method } = await assignJobInTx(
      tx,
      actor,
      ctx,
      row.jobId,
      { employeeId, reason: input.reason, override: input.override },
      { recommendation: { id: row.id, method: input.decision === "APPROVED" ? "RECOMMENDATION_APPROVED" : "RECOMMENDATION_MODIFIED" } },
      notificationIds,
    );
    const updated = await tx.dispatchRecommendation.update({
      where: { id: row.id },
      data: { status: input.decision, chosenEmployeeId: employeeId, decidedAt: new Date(), decidedById: actor.userId, decisionReason: input.reason ?? null },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: input.decision === "APPROVED" ? "dispatch.recommendation_approve" : "dispatch.recommendation_modify",
      targetType: "DispatchRecommendation",
      targetId: row.id,
      previousValue: { status: "PENDING", recommendedEmployeeId: candidates[0]?.employeeId ?? null },
      // §7.4: a departure from the recommendation is recorded with who, whom, which rank, whether an eligibility override was needed.
      newValue: {
        status: input.decision,
        chosenEmployeeId: employeeId,
        chosenRank: candidates.find((candidate) => candidate.employeeId === employeeId)?.rank ?? null,
        assignmentMethod: method,
        overrideUsed: method === "OVERRIDE",
      },
      reason: input.override?.reason ?? input.reason,
    });
    return (await viewRecommendationsFor(tx, actor, [updated]))[0];
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return view;
}

/**
 * Accepts the top-ranked candidate. Needs `dispatch.assign` over the job plus the jobs module's own checks
 * (`jobs.assign`; the hard eligibility is re-checked at this moment, so a candidate who became unavailable
 * since generation is refused with the reasons).
 * @throws ConflictError when there is no candidate ("no eligible technician"), when the top candidate is outside the
 *   approver's employee scope, or when the recommendation is stale.
 */
export async function approveRecommendation(actor: Actor, ctx: RequestContext, recommendationId: string, input: ApproveRecommendationInput): Promise<RecommendationView> {
  return accept(actor, ctx, recommendationId, { decision: "APPROVED", reason: input.reason, override: undefined }, (row, visible) => {
    const top = storedCandidates(row).ranked[0];
    if (!top) throw new ConflictError({ message: "There is no eligible technician to approve. Fix the blocking reasons or assign by hand." });
    if (!visible.has(top.employeeId)) {
      throw new ConflictError({ message: "The recommended employee is outside your scope. Choose someone you can see, or generate a new recommendation." });
    }
    return top.employeeId;
  });
}

/**
 * Chooses someone other than the top candidate (any employee the caller may see: another candidate, or one outside the list).
 * The reason is required. If the choice fails the hard eligibility rules the request must carry an
 * `override` and the caller must hold `jobs.approve` (see jobs assignment); the assignment is then method
 * OVERRIDE and the override is recorded on the assignment, the job's events and the audit log.
 */
export async function modifyRecommendation(actor: Actor, ctx: RequestContext, recommendationId: string, input: ModifyRecommendationInput): Promise<RecommendationView> {
  return accept(actor, ctx, recommendationId, { decision: "MODIFIED", reason: input.reason, override: input.override }, (row) => {
    if (storedCandidates(row).ranked[0]?.employeeId === input.employeeId) {
      throw new ValidationError({ message: "That employee is the recommended one: approve the recommendation instead.", field: "employeeId" });
    }
    return input.employeeId;
  });
}

/** Rejects the recommendation; the job stays pending and nobody is assigned. Needs `dispatch.assign`; the reason is required and kept. */
export async function rejectRecommendation(actor: Actor, ctx: RequestContext, recommendationId: string, input: RejectRecommendationInput): Promise<RecommendationView> {
  return withTenant(actor.tenantId, async (tx) => {
    const row = await claimPending(tx, actor, recommendationId, false);
    const updated = await tx.dispatchRecommendation.update({
      where: { id: row.id },
      data: { status: "REJECTED", decidedAt: new Date(), decidedById: actor.userId, decisionReason: input.reason },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "dispatch.recommendation_reject",
      targetType: "DispatchRecommendation",
      targetId: row.id,
      previousValue: { status: "PENDING", recommendedEmployeeId: storedCandidates(row).ranked[0]?.employeeId ?? null },
      newValue: { status: "REJECTED" },
      reason: input.reason,
    });
    return (await viewRecommendationsFor(tx, actor, [updated]))[0];
  });
}
