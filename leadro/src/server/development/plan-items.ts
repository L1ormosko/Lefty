import type { DevelopmentAction, DevelopmentGoal } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { canInTx } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { dateColumn, isoDateOf, textDigest } from "./access";
import { assertChangeable, loadPlanForChange, loadPlanView } from "./plans";
import type { CreateActionInput, CreateGoalInput, CreateReviewInput, UpdateActionInput, UpdateGoalInput } from "./schemas";
import type { PlanView } from "./views";

/**
 * Goals, actions and review entries of a development plan. All need `development_plans.edit` over the plan's employee;
 * goals and actions change only while the plan is DRAFT or ACTIVE. Every call returns the whole plan.
 *
 * - A goal may name a PUBLISHED metric definition it is about (context only, never a threshold that triggers anything).
 * - A TRAINING action links a training assignment, a COACHING action may link a coaching record, both of the plan's
 *   employee (composite FKs); the caller must be able to see the linked record (`training.view` / `coaching.view`).
 * - Actions go PLANNED -> DONE | CANCELLED (final). Goals go OPEN <-> ACHIEVED / DROPPED.
 * - Reviews are append-only (DB trigger); each stores the plan's status at that moment.
 * - No free text in audit events: only digests of titles, descriptions and review bodies.
 */

const goalAudit = (goal: DevelopmentGoal) => ({
  planId: goal.planId,
  status: goal.status,
  targetDate: isoDateOf(goal.targetDate),
  metricDefinitionId: goal.metricDefinitionId,
  position: goal.position,
  titleSha256: textDigest(goal.title),
  descriptionSha256: textDigest(goal.description),
});

const actionAudit = (action: DevelopmentAction) => ({
  planId: action.planId,
  goalId: action.goalId,
  kind: action.kind,
  status: action.status,
  dueDate: isoDateOf(action.dueDate),
  trainingAssignmentId: action.trainingAssignmentId,
  coachingRecordId: action.coachingRecordId,
  descriptionSha256: textDigest(action.description),
});

/** The metric definition a goal names must be PUBLISHED (what the employee can see); a 400 otherwise. */
async function assertPublishedDefinition(tx: TenantTx, tenantId: string, definitionId: string): Promise<void> {
  const definition = await tx.performanceMetricDefinition.findFirst({ where: { id: definitionId, tenantId, status: "PUBLISHED" }, select: { id: true } });
  if (!definition) throw new ValidationError({ message: "Unknown or unpublished metric definition.", field: "metricDefinitionId" });
}

async function assertGoalOfPlan(tx: TenantTx, tenantId: string, planId: string, goalId: string): Promise<void> {
  const goal = await tx.developmentGoal.findFirst({ where: { id: goalId, planId, tenantId }, select: { id: true } });
  if (!goal) throw new ValidationError({ message: "The goal is not part of this plan.", field: "goalId" });
}

/** `POST /development-plans/{id}/goals`. */
export async function addGoal(actor: Actor, ctx: RequestContext, planId: string, input: CreateGoalInput): Promise<PlanView> {
  return withTenant(actor.tenantId, async (tx) => {
    const plan = await loadPlanForChange(tx, actor, planId);
    assertChangeable(plan);
    if (input.metricDefinitionId) await assertPublishedDefinition(tx, actor.tenantId, input.metricDefinitionId);
    const goal = await tx.developmentGoal.create({
      data: {
        tenantId: actor.tenantId,
        planId,
        title: input.title,
        description: input.description ?? null,
        targetDate: input.targetDate ? dateColumn(input.targetDate) : null,
        metricDefinitionId: input.metricDefinitionId ?? null,
        position: input.position ?? 0,
      },
    });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "development_goal.create", targetType: "DevelopmentGoal", targetId: goal.id, newValue: goalAudit(goal) });
    return loadPlanView(tx, actor.tenantId, planId);
  });
}

/** `PATCH /development-plans/{id}/goals/{goalId}`: text, date, metric, order or status of a goal. */
export async function updateGoal(actor: Actor, ctx: RequestContext, planId: string, goalId: string, input: UpdateGoalInput): Promise<PlanView> {
  return withTenant(actor.tenantId, async (tx) => {
    const plan = await loadPlanForChange(tx, actor, planId);
    assertChangeable(plan);
    const before = await tx.developmentGoal.findFirst({ where: { id: goalId, planId, tenantId: actor.tenantId } });
    if (!before) throw new NotFoundError();
    if (input.metricDefinitionId) await assertPublishedDefinition(tx, actor.tenantId, input.metricDefinitionId);
    const statusChange = input.status !== undefined && input.status !== before.status ? input.status : undefined;
    if (statusChange && before.status !== "OPEN" && statusChange !== "OPEN") {
      throw new InvalidStateTransitionError({ message: "Reopen the goal before changing its outcome." });
    }
    const after = await tx.developmentGoal.update({
      where: { id: goalId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.targetDate !== undefined ? { targetDate: input.targetDate ? dateColumn(input.targetDate) : null } : {}),
        ...(input.metricDefinitionId !== undefined ? { metricDefinitionId: input.metricDefinitionId } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(statusChange ? { status: statusChange, achievedAt: statusChange === "ACHIEVED" ? new Date() : null } : {}),
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "development_goal.update",
      targetType: "DevelopmentGoal",
      targetId: goalId,
      previousValue: goalAudit(before),
      newValue: goalAudit(after),
    });
    return loadPlanView(tx, actor.tenantId, planId);
  });
}

/**
 * The record an action links must be the plan employee's and visible to the actor; otherwise it is "unknown" (a 400 that
 * confirms nothing about records outside the caller's scope).
 */
async function assertLinkableRecords(tx: TenantTx, actor: Actor, employeeId: string, input: CreateActionInput): Promise<void> {
  if (input.trainingAssignmentId) {
    const assignment = await tx.trainingAssignment.findFirst({ where: { id: input.trainingAssignmentId, tenantId: actor.tenantId, employeeId }, select: { id: true } });
    const visible = assignment && (await canInTx(tx, actor, "training.view", { employeeId })).allowed;
    if (!visible) throw new ValidationError({ message: "Unknown training assignment of this employee.", field: "trainingAssignmentId" });
  }
  if (input.coachingRecordId) {
    const record = await tx.coachingRecord.findFirst({ where: { id: input.coachingRecordId, tenantId: actor.tenantId, employeeId }, select: { id: true } });
    const visible = record && (await canInTx(tx, actor, "coaching.view", { employeeId })).allowed;
    if (!visible) throw new ValidationError({ message: "Unknown coaching record of this employee.", field: "coachingRecordId" });
  }
}

/**
 * Adds an action to a plan the caller has already loaded for change (also used when a recommendation is accepted into a
 * plan). Audits it.
 */
export async function addActionInTx(
  tx: TenantTx,
  actor: Actor,
  ctx: RequestContext,
  plan: { id: string; employeeId: string },
  input: CreateActionInput,
): Promise<DevelopmentAction> {
  if (input.goalId) await assertGoalOfPlan(tx, actor.tenantId, plan.id, input.goalId);
  await assertLinkableRecords(tx, actor, plan.employeeId, input);
  const action = await tx.developmentAction.create({
    data: {
      tenantId: actor.tenantId,
      planId: plan.id,
      employeeId: plan.employeeId,
      goalId: input.goalId ?? null,
      kind: input.kind,
      description: input.description,
      dueDate: input.dueDate ? dateColumn(input.dueDate) : null,
      trainingAssignmentId: input.trainingAssignmentId ?? null,
      coachingRecordId: input.coachingRecordId ?? null,
    },
  });
  await recordAudit(tx, { ...auditContextFields(ctx), action: "development_action.create", targetType: "DevelopmentAction", targetId: action.id, newValue: actionAudit(action) });
  return action;
}

/** `POST /development-plans/{id}/actions`. */
export async function addAction(actor: Actor, ctx: RequestContext, planId: string, input: CreateActionInput): Promise<PlanView> {
  return withTenant(actor.tenantId, async (tx) => {
    const plan = await loadPlanForChange(tx, actor, planId);
    assertChangeable(plan);
    await addActionInTx(tx, actor, ctx, plan, input);
    return loadPlanView(tx, actor.tenantId, planId);
  });
}

/** `PATCH /development-plans/{id}/actions/{actionId}`: a PLANNED action's text / goal / due date, or its outcome. */
export async function updateAction(actor: Actor, ctx: RequestContext, planId: string, actionId: string, input: UpdateActionInput): Promise<PlanView> {
  return withTenant(actor.tenantId, async (tx) => {
    const plan = await loadPlanForChange(tx, actor, planId);
    assertChangeable(plan);
    const before = await tx.developmentAction.findFirst({ where: { id: actionId, planId, tenantId: actor.tenantId } });
    if (!before) throw new NotFoundError();
    if (before.status !== "PLANNED") throw new InvalidStateTransitionError({ message: `A ${before.status.toLowerCase()} action cannot change.` });
    if (input.goalId) await assertGoalOfPlan(tx, actor.tenantId, planId, input.goalId);
    const after = await tx.developmentAction.update({
      where: { id: actionId },
      data: {
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? dateColumn(input.dueDate) : null } : {}),
        ...(input.status ? { status: input.status, ...(input.status === "DONE" ? { completedAt: new Date() } : {}) } : {}),
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "development_action.update",
      targetType: "DevelopmentAction",
      targetId: actionId,
      previousValue: actionAudit(before),
      newValue: actionAudit(after),
    });
    return loadPlanView(tx, actor.tenantId, planId);
  });
}

/** `POST /development-plans/{id}/reviews`: appends a review entry (any status but CANCELLED); the reviewer is the caller. */
export async function addReview(actor: Actor, ctx: RequestContext, planId: string, input: CreateReviewInput): Promise<PlanView> {
  return withTenant(actor.tenantId, async (tx) => {
    const plan = await loadPlanForChange(tx, actor, planId);
    if (plan.status === "CANCELLED") throw new InvalidStateTransitionError({ message: "A cancelled development plan takes no reviews." });
    const review = await tx.developmentPlanReview.create({
      data: { tenantId: actor.tenantId, planId, reviewerId: actor.userId, planStatus: plan.status, body: input.body },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "development_plan.review",
      targetType: "DevelopmentPlan",
      targetId: planId,
      newValue: { reviewId: review.id, planStatus: review.planStatus, bodySha256: textDigest(review.body) },
    });
    return loadPlanView(tx, actor.tenantId, planId);
  });
}
