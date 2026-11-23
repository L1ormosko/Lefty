import type { DispatchRecommendation, Prisma } from "@prisma/client";
import type { EligibilityFailure } from "@/lib/eligibility";
import type { RankedCandidate } from "@/lib/dispatch-scoring";
import type { ResourceRef } from "@/server/authz";
import { enforceInTx } from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { jobResourceRef } from "@/server/jobs";

/**
 * How a stored recommendation is shown. The JSON columns hold IDS and CODES only (ERD "Contracts for
 * JSON"): employee ids, factor keys, numbers, i18n keys. Clients resolve names through the employees API,
 * which re-checks what the viewer may see, and translate every `explanationKey` / `messageKey` /
 * failure code themselves (`DISPATCH.*`, `QUALIFICATION.FAILURE.<code>`).
 */

/** Always attached so a distance is never mistaken for travel time (§28.3). i18n key `DISPATCH.STRAIGHT_LINE_ESTIMATE`. */
export const DISTANCE_BASIS = "STRAIGHT_LINE_ESTIMATE";

export type BlockingReasons = Record<string, EligibilityFailure[]>;

export interface RecommendationView {
  id: string;
  jobId: string;
  mode: string;
  status: string;
  candidates: RankedCandidate[];
  /** Why people were not eligible (only stored when NOBODY was: the "no eligible technician" path). Null otherwise. */
  blockingReasons: BlockingReasons | null;
  distanceBasis: typeof DISTANCE_BASIS;
  generatedAt: Date;
  generatedById: string | null;
  chosenEmployeeId: string | null;
  decidedAt: Date | null;
  decidedById: string | null;
  decisionReason: string | null;
}

export function recommendationView(row: DispatchRecommendation): RecommendationView {
  return {
    id: row.id,
    jobId: row.jobId,
    mode: row.mode,
    status: row.status,
    candidates: row.candidates as unknown as RankedCandidate[],
    blockingReasons: row.blockingReasons as unknown as BlockingReasons | null,
    distanceBasis: DISTANCE_BASIS,
    generatedAt: row.generatedAt,
    generatedById: row.generatedById,
    chosenEmployeeId: row.chosenEmployeeId,
    decidedAt: row.decidedAt,
    decidedById: row.decidedById,
    decisionReason: row.decisionReason,
  };
}

/** Prisma JSON input for the candidate list (typed once, here). */
export const candidatesJson = (candidates: RankedCandidate[]): Prisma.InputJsonValue => candidates as unknown as Prisma.InputJsonValue;
export const blockingJson = (blocking: BlockingReasons): Prisma.InputJsonValue => blocking as unknown as Prisma.InputJsonValue;

/**
 * Authorizes `permission` over the job (capability first, then over the job's service area / assignees)
 * and returns its resource reference. A job outside the caller's scope is a 404, never a 403.
 */
export async function authorizeOverJob(tx: TenantTx, actor: Actor, permission: string, jobId: string): Promise<ResourceRef> {
  await enforceInTx(tx, actor, permission);
  const ref = await jobResourceRef(tx, actor.tenantId, jobId);
  if (!ref) throw new NotFoundError();
  await enforceInTx(tx, actor, permission, ref);
  return ref;
}
