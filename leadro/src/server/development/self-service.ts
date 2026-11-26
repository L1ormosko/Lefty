import { z } from "zod";
import { NotFoundError, pageArgs, pageQuerySchema, toPage, type Actor, type Page } from "@/server/core";
import { withTenant } from "@/server/db";
import { loadPlanView } from "./plans";
import { toPlanSummaryView, type PlanSummaryView, type PlanView } from "./views";

/**
 * Self-service (spec 5.11, PERMISSIONS.md section 12, `/api/v1/me/development-plans/*`): the caller reads their OWN plans
 * once they left DRAFT (a draft is the manager's work in progress). No module permission: the query is filtered on the
 * caller's employee record (a user without one sees nothing; another person's plan is a 404).
 *
 * What the employee does NOT see (the manager's private notes, spec 22.2):
 * - review entries' text and reviewer (`reviews` keep only when and in which plan status a review happened);
 * - the cancellation reason;
 * - the link to a coaching note that was not shared with them or was archived (`coachingRecordId` is null then).
 */

const VISIBLE_STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED"] as const;

export const ownPlansQuerySchema = pageQuerySchema.extend({ status: z.enum(VISIBLE_STATUSES).optional() }).strict();
export type OwnPlansQuery = z.infer<typeof ownPlansQuerySchema>;

export type OwnPlanSummaryView = Omit<PlanSummaryView, "cancelReason">;
export type OwnPlanView = OwnPlanSummaryView &
  Pick<PlanView, "goals" | "actions"> & { reviews: Array<{ id: string; planStatus: string; reviewedAt: string }> };

const withoutCancelReason = ({ cancelReason: _cancelReason, ...rest }: PlanSummaryView): OwnPlanSummaryView => rest;

/** `GET /me/development-plans`: the caller's ACTIVE / COMPLETED / CANCELLED plans, newest first. */
export async function listOwnPlans(actor: Actor, query: OwnPlansQuery): Promise<Page<OwnPlanSummaryView>> {
  const employeeId = actor.employeeId;
  if (!employeeId) return toPage([], query.limit);
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.developmentPlan.findMany({
      where: { tenantId: actor.tenantId, employeeId, status: query.status ?? { in: [...VISIBLE_STATUSES] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => withoutCancelReason(toPlanSummaryView(row))), page: page.page };
  });
}

/** `GET /me/development-plans/{id}`: one of the caller's non-draft plans with goals, actions and the review dates. */
export async function getOwnPlan(actor: Actor, planId: string): Promise<OwnPlanView> {
  const employeeId = actor.employeeId;
  if (!employeeId) throw new NotFoundError();
  return withTenant(actor.tenantId, async (tx) => {
    const plan = await tx.developmentPlan.findFirst({
      where: { id: planId, tenantId: actor.tenantId, employeeId, status: { in: [...VISIBLE_STATUSES] } },
      select: { id: true },
    });
    if (!plan) throw new NotFoundError();
    const { goals, actions, reviews, ...summary } = await loadPlanView(tx, actor.tenantId, plan.id);
    const linkedNoteIds = actions.flatMap((action) => (action.coachingRecordId ? [action.coachingRecordId] : []));
    const sharedNotes = linkedNoteIds.length
      ? await tx.coachingRecord.findMany({
          where: { tenantId: actor.tenantId, employeeId, id: { in: linkedNoteIds }, sharedWithEmployee: true, archivedAt: null },
          select: { id: true },
        })
      : [];
    const shared = new Set(sharedNotes.map((note) => note.id));
    return {
      ...withoutCancelReason(summary),
      goals,
      actions: actions.map((action) => ({ ...action, coachingRecordId: action.coachingRecordId && shared.has(action.coachingRecordId) ? action.coachingRecordId : null })),
      reviews: reviews.map((review) => ({ id: review.id, planStatus: review.planStatus, reviewedAt: review.reviewedAt })),
    };
  });
}
