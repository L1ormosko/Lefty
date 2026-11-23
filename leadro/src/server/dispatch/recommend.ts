import { ASSIGNABLE_STATUSES, type JobStatusValue } from "@/lib/job-lifecycle";
import { rankCandidates } from "@/lib/dispatch-scoring";
import type { EligibilityFailure } from "@/lib/eligibility";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { buildEligibilityPicture, loadCandidateFacts, MAX_POOL } from "./picture";
import type { ListRecommendationsQuery } from "./schemas";
import { assertRecommendationsAvailable, loadDispatchMode } from "./settings";
import { authorizeOverJob, blockingJson, candidatesJson, recommendationView, type BlockingReasons, type RecommendationView } from "./views";

/**
 * Generating and reading recommendations (§7.3-7.4, §25.2). The engine is rule-based and explainable:
 *  1. HARD filter: the qualification engine over every non-terminated employee (`buildEligibilityPicture`);
 *  2. SOFT ranking of the eligible only: distance, workload, experience, customer preference
 *     (`@/lib/dispatch-scoring`, every factor and its points are stored);
 *  3. "no eligible technician": the recommendation has no candidates and stores the blocking reasons per
 *     employee; the job stays PENDING_ASSIGNMENT. Nothing is ever assigned by generating a recommendation.
 * A new recommendation SUPERSEDES the job's still-pending ones, so exactly one can be decided at a time.
 */

const toBlockingReasons = (blocked: Array<{ employeeId: string; failures: EligibilityFailure[] }>): BlockingReasons =>
  Object.fromEntries(blocked.map((entry) => [entry.employeeId, entry.failures]));

/**
 * Generates and stores a recommendation for an unassigned job. Needs `dispatch.create` over the job.
 * Refused in MANUAL mode (and for modes this phase cannot run) and for jobs that can no longer be assigned.
 */
export async function generateRecommendation(actor: Actor, ctx: RequestContext, jobId: string): Promise<RecommendationView> {
  return withTenant(actor.tenantId, async (tx) => {
    await authorizeOverJob(tx, actor, "dispatch.create", jobId);
    const mode = await loadDispatchMode(tx, actor.tenantId);
    assertRecommendationsAvailable(mode);

    // Two dispatchers generating at once must not both leave a PENDING recommendation behind.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dispatch-recommendation:${jobId}`}))`;
    const now = new Date();
    const picture = await buildEligibilityPicture(tx, actor.tenantId, jobId, now);
    if (!ASSIGNABLE_STATUSES.includes(picture.job.status as JobStatusValue)) {
      throw new InvalidStateTransitionError({ message: `A job in status ${picture.job.status} can no longer be assigned.` });
    }
    const ranked = rankCandidates(await loadCandidateFacts(tx, actor.tenantId, picture.job, picture.eligibleEmployeeIds, now));

    const superseded = await tx.dispatchRecommendation.updateMany({ where: { tenantId: actor.tenantId, jobId, status: "PENDING" }, data: { status: "SUPERSEDED" } });
    const row = await tx.dispatchRecommendation.create({
      data: {
        tenantId: actor.tenantId,
        jobId,
        mode: "AI_ASSISTED",
        candidates: candidatesJson(ranked),
        blockingReasons: ranked.length === 0 ? blockingJson(toBlockingReasons(picture.blocked)) : undefined,
        generatedAt: now,
        generatedById: actor.userId,
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "dispatch.recommend",
      targetType: "DispatchRecommendation",
      targetId: row.id,
      newValue: {
        jobId,
        mode,
        candidateEmployeeIds: ranked.map((candidate) => candidate.employeeId),
        eligibleCount: ranked.length,
        evaluatedCount: ranked.length + picture.blocked.length,
        poolLimit: MAX_POOL,
        supersededCount: superseded.count,
      },
    });
    return recommendationView(row);
  });
}

export interface EligibilityOverview {
  jobId: string;
  distanceBasis: "STRAIGHT_LINE_ESTIMATE";
  /** Employees who pass every hard rule right now, unranked (manual dispatch picks from these). */
  eligibleEmployeeIds: string[];
  /** Everyone else evaluated, with every failed rule (`QUALIFICATION.FAILURE.<code>`). */
  blocked: Array<{ employeeId: string; failures: EligibilityFailure[] }>;
}

/**
 * Who could take this job right now and why the others cannot (works in every mode, stores nothing).
 * Needs `dispatch.view` over the job.
 */
export async function getEligibilityOverview(actor: Actor, jobId: string): Promise<EligibilityOverview> {
  return withTenant(actor.tenantId, async (tx) => {
    await authorizeOverJob(tx, actor, "dispatch.view", jobId);
    const picture = await buildEligibilityPicture(tx, actor.tenantId, jobId);
    return { jobId, distanceBasis: "STRAIGHT_LINE_ESTIMATE", eligibleEmployeeIds: picture.eligibleEmployeeIds, blocked: picture.blocked };
  });
}

/** The job's recommendations, newest first. Needs `dispatch.view` over the job. */
export async function listRecommendations(actor: Actor, jobId: string, query: ListRecommendationsQuery): Promise<Page<RecommendationView & { id: string }>> {
  return withTenant(actor.tenantId, async (tx) => {
    await authorizeOverJob(tx, actor, "dispatch.view", jobId);
    const rows = await tx.dispatchRecommendation.findMany({
      where: { tenantId: actor.tenantId, jobId },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(recommendationView), page: page.page };
  });
}

/** One recommendation. Needs `dispatch.view` over its job; an unknown id and an out-of-scope job are both 404. */
export async function getRecommendation(actor: Actor, recommendationId: string): Promise<RecommendationView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "dispatch.view");
    const row = await tx.dispatchRecommendation.findFirst({ where: { id: recommendationId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    await authorizeOverJob(tx, actor, "dispatch.view", row.jobId);
    return recommendationView(row);
  });
}
