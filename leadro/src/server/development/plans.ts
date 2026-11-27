import type { DevelopmentPlan, Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import {
  assertEligibleOwner,
  assertNotAboutSelf,
  dateColumn,
  enforceOverEmployee,
  isAboutCaller,
  isoDateOf,
  lockRow,
  notAboutCaller,
  planScopeColumns,
  textDigest,
} from "./access";
import { notifyPlanActivated } from "./notify";
import type { CancelPlanInput, CreatePlanInput, ListPlansQuery, UpdatePlanInput } from "./schemas";
import { toPlanSummaryView, toPlanView, type PlanSummaryView, type PlanView } from "./views";

/**
 * Development plans (spec 10.4 "development plans", 5.4, 5.8): a plan for one employee over a period, with goals, actions
 * and an append-only review history. DRAFT -> ACTIVE -> COMPLETED, or DRAFT / ACTIVE -> CANCELLED with a reason (DB
 * trigger `development_plan_status`). Permissions `development_plans.view / .create / .edit` over the EMPLOYEE; their
 * `view` is sensitive. Development use only (spec 10.3): nothing here feeds dispatch, eligibility, pay or employment.
 *
 * - Nobody runs a plan about themselves; the owner must be able to edit it and is never the employee.
 * - Only DRAFT and ACTIVE plans change (title, period, owner, goals, actions); COMPLETED and CANCELLED are final.
 * - No free text in audit events (spec 22.2): titles and summaries are audited as SHA-256 digests.
 */

const VIEW = "development_plans.view";
const EDIT = "development_plans.edit";
export const CHANGEABLE_STATUSES = ["DRAFT", "ACTIVE"] as const;

/** What an audit event may say about a plan: ids, dates, status and the text digests (never the text). */
const auditValue = (plan: DevelopmentPlan) => ({
  employeeId: plan.employeeId,
  ownerId: plan.ownerId,
  status: plan.status,
  periodStart: isoDateOf(plan.periodStart),
  periodEnd: isoDateOf(plan.periodEnd),
  titleSha256: textDigest(plan.title),
  summarySha256: textDigest(plan.summary),
});

/** Loads a plan with its goals, actions and reviews in their display order. */
export async function loadPlanView(tx: TenantTx, tenantId: string, planId: string): Promise<PlanView> {
  const row = await tx.developmentPlan.findFirst({
    where: { id: planId, tenantId },
    include: {
      goals: { orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
      actions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      reviews: { orderBy: [{ reviewedAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!row) throw new NotFoundError();
  return toPlanView(row);
}

/**
 * Loads (and row-locks) a plan the actor may change: `development_plans.edit` over its employee (403 without the
 * capability, 404 outside the scope).
 */
export async function loadPlanForChange(tx: TenantTx, actor: Actor, planId: string): Promise<DevelopmentPlan> {
  await enforceInTx(tx, actor, EDIT);
  await lockRow(tx, "DevelopmentPlan", actor.tenantId, planId);
  const plan = await tx.developmentPlan.findFirstOrThrow({ where: { id: planId, tenantId: actor.tenantId } });
  await enforceOverEmployee(tx, actor, VIEW, plan.employeeId);
  await enforceOverEmployee(tx, actor, EDIT, plan.employeeId);
  // P5-R2: nobody changes, reviews or moves a plan about themselves (creating one is already refused). A 404 like the
  // read (P5-R1): a DRAFT plan about the caller is not even confirmed to exist.
  if (isAboutCaller(actor, plan.employeeId)) throw new NotFoundError();
  return plan;
}

/** @throws InvalidStateTransitionError unless the plan is DRAFT or ACTIVE. */
export function assertChangeable(plan: DevelopmentPlan): void {
  if (!(CHANGEABLE_STATUSES as readonly string[]).includes(plan.status)) {
    throw new InvalidStateTransitionError({ message: `A ${plan.status.toLowerCase()} development plan cannot change.` });
  }
}

/** `POST /development-plans`: a DRAFT plan for an employee in the caller's `development_plans.create` scope. */
export async function createPlan(actor: Actor, ctx: RequestContext, input: CreatePlanInput): Promise<PlanView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceOverEmployee(tx, actor, "development_plans.create", input.employeeId);
    assertNotAboutSelf(actor, input.employeeId);
    const employee = await tx.employee.findFirstOrThrow({ where: { id: input.employeeId, tenantId: actor.tenantId }, select: { status: true } });
    if (employee.status === "TERMINATED") throw new InvalidStateTransitionError({ message: "A terminated employee gets no new development plan." });
    const ownerId = input.ownerId ?? actor.userId;
    await assertEligibleOwner(tx, actor.tenantId, ownerId, input.employeeId);
    const plan = await tx.developmentPlan.create({
      data: {
        tenantId: actor.tenantId,
        employeeId: input.employeeId,
        ownerId,
        title: input.title,
        summary: input.summary ?? null,
        periodStart: dateColumn(input.periodStart),
        periodEnd: dateColumn(input.periodEnd),
        createdById: actor.userId,
      },
    });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "development_plan.create", targetType: "DevelopmentPlan", targetId: plan.id, newValue: auditValue(plan) });
    return loadPlanView(tx, actor.tenantId, plan.id);
  });
}

/** `PATCH /development-plans/{id}`: title, summary, period and owner of a DRAFT or ACTIVE plan (`development_plans.edit`). */
export async function updatePlan(actor: Actor, ctx: RequestContext, planId: string, input: UpdatePlanInput): Promise<PlanView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadPlanForChange(tx, actor, planId);
    assertChangeable(before);
    const periodStart = input.periodStart ?? (isoDateOf(before.periodStart) as string);
    const periodEnd = input.periodEnd ?? (isoDateOf(before.periodEnd) as string);
    if (periodEnd <= periodStart) throw new ValidationError({ message: "The period must end after it starts.", field: "periodEnd" });
    if (input.ownerId !== undefined && input.ownerId !== before.ownerId) await assertEligibleOwner(tx, actor.tenantId, input.ownerId, before.employeeId);

    const { changedKeys, previous, next } = changedFields(
      { titleSha256: textDigest(before.title), summarySha256: textDigest(before.summary), periodStart: isoDateOf(before.periodStart), periodEnd: isoDateOf(before.periodEnd), ownerId: before.ownerId },
      {
        titleSha256: input.title !== undefined ? textDigest(input.title) : undefined,
        summarySha256: input.summary !== undefined ? textDigest(input.summary) : undefined,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        ownerId: input.ownerId,
      },
    );
    if (changedKeys.length === 0) return loadPlanView(tx, actor.tenantId, planId);
    await tx.developmentPlan.update({
      where: { id: planId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.periodStart !== undefined ? { periodStart: dateColumn(input.periodStart) } : {}),
        ...(input.periodEnd !== undefined ? { periodEnd: dateColumn(input.periodEnd) } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      },
    });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "development_plan.update", targetType: "DevelopmentPlan", targetId: planId, previousValue: previous, newValue: next });
    return loadPlanView(tx, actor.tenantId, planId);
  });
}

type Transition = "activate" | "complete" | "cancel";

const TRANSITIONS: Record<Transition, { from: readonly DevelopmentPlan["status"][]; to: DevelopmentPlan["status"] }> = {
  activate: { from: ["DRAFT"], to: "ACTIVE" },
  complete: { from: ["ACTIVE"], to: "COMPLETED" },
  cancel: { from: ["DRAFT", "ACTIVE"], to: "CANCELLED" },
};

async function transition(actor: Actor, ctx: RequestContext, planId: string, name: Transition, cancelReason?: string): Promise<PlanView> {
  const { view, notificationIds } = await withTenant(actor.tenantId, async (tx) => {
    const before = await loadPlanForChange(tx, actor, planId);
    const { from, to } = TRANSITIONS[name];
    if (!from.includes(before.status)) {
      throw new InvalidStateTransitionError({ message: `A ${before.status.toLowerCase()} development plan cannot be ${to.toLowerCase()}.` });
    }
    const now = new Date();
    const after = await tx.developmentPlan.update({
      where: { id: planId },
      data: {
        status: to,
        ...(name === "activate" ? { activatedAt: now } : {}),
        ...(name === "complete" ? { completedAt: now } : {}),
        ...(name === "cancel" ? { cancelledAt: now, cancelReason } : {}),
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: `development_plan.${name}`,
      targetType: "DevelopmentPlan",
      targetId: planId,
      previousValue: { status: before.status },
      // The cancel reason is free text about the person: only its digest is audited (spec 22.2).
      newValue: { status: after.status, ...(cancelReason ? { cancelReasonSha256: textDigest(cancelReason) } : {}) },
    });
    const ids = name === "activate" ? await notifyPlanActivated(tx, after) : [];
    return { view: await loadPlanView(tx, actor.tenantId, planId), notificationIds: ids };
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return view;
}

/** `POST /development-plans/{id}/activate`: DRAFT -> ACTIVE; the employee is told (they read it through self-service). */
export const activatePlan = (actor: Actor, ctx: RequestContext, planId: string): Promise<PlanView> => transition(actor, ctx, planId, "activate");

/** `POST /development-plans/{id}/complete`: ACTIVE -> COMPLETED. Open goals and planned actions stay as they are (history). */
export const completePlan = (actor: Actor, ctx: RequestContext, planId: string): Promise<PlanView> => transition(actor, ctx, planId, "complete");

/** `POST /development-plans/{id}/cancel`: DRAFT / ACTIVE -> CANCELLED with a reason. */
export const cancelPlan = (actor: Actor, ctx: RequestContext, planId: string, input: CancelPlanInput): Promise<PlanView> =>
  transition(actor, ctx, planId, "cancel", input.reason);

/** `GET /development-plans/{id}`: the plan with goals, actions and reviews (`development_plans.view`; out of scope 404). */
export async function getPlan(actor: Actor, planId: string): Promise<PlanView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, VIEW);
    const plan = await tx.developmentPlan.findFirst({ where: { id: planId, tenantId: actor.tenantId }, select: { employeeId: true } });
    // The caller's own plans are read through self-service (without the review notes), never here (P5-R1).
    if (!plan || isAboutCaller(actor, plan.employeeId)) throw new NotFoundError();
    await enforceOverEmployee(tx, actor, VIEW, plan.employeeId);
    return loadPlanView(tx, actor.tenantId, planId);
  });
}

/** `GET /development-plans`: plans in the caller's scope (the employee's scope is part of the query), newest first. */
export async function listPlans(actor: Actor, query: ListPlansQuery): Promise<Page<PlanSummaryView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, VIEW);
    const now = new Date();
    const scope = await resolveScope(tx, actor, VIEW, now);
    const callerWhere: Prisma.DevelopmentPlanWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      // Never plans about the caller (P5-R1): `/api/v1/me/development-plans` shows them without the manager's notes.
      AND: [notAboutCaller(actor)],
    };
    const rows = await tx.developmentPlan.findMany({
      where: withinScope(buildScopeWhere(scope, planScopeColumns, now), callerWhere),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toPlanSummaryView), page: page.page };
  });
}
