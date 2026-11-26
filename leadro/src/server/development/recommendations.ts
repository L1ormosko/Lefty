import type { Prisma, TrainingRecommendation } from "@prisma/client";
import { auditContextFields, recordAudit, type AuditContextFields } from "@/server/audit";
import { buildScopeWhere, employeeScopeColumns, enforceInTx, narrowScopeToFieldSet, resolveScope, withinScope } from "@/server/authz";
import {
  conflictOnUniqueViolation,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { logger } from "@/server/logging";
import { deliverAfterCommit } from "@/server/notifications";
import { createTrainingAssignmentInTx, TRAINING_ASSIGNMENT_ALREADY_OPEN } from "@/server/training";
import { enforceOverEmployee, isAboutCaller, lockRow, recommendationScopeColumns, tenantCalendar, textDigest } from "./access";
import { addActionInTx } from "./plan-items";
import { assertChangeable, loadPlanForChange } from "./plans";
import { evaluateRecommendationRules, pairKey, reasonIdentity, type RecommendationReason } from "./rules";
import type { AcceptRecommendationInput, DismissRecommendationInput, GenerateRecommendationsInput, ListRecommendationsQuery } from "./schemas";
import { toRecommendationView, type RecommendationView } from "./views";

/**
 * Training recommendations (spec 5.4 "recommend training", 28.6): produced by the deterministic rules in `rules.ts` when
 * someone (or a worker) explicitly asks for a run, never on a schedule of this module's own; never auto-assigned. A
 * person accepts one (OPEN -> ACCEPTED, creating a training assignment with source RECOMMENDATION in the same
 * transaction) or dismisses it with a reason (OPEN -> DISMISSED). One OPEN recommendation per employee and course (DB
 * partial unique index `training_recommendation_one_open`).
 *
 * A run over a set of ACTIVE employees:
 *  - creates an OPEN recommendation for each employee + course with at least one reason, unless one is already OPEN, the
 *    employee already has an open assignment of the course, or a recommendation of that pair DECIDED BY A PERSON already
 *    covered every current reason (same `reasonIdentity`): a dismissed finding is not raised again until something new
 *    happens (a new expiry date, another job type, another period);
 *  - dismisses, as the system (`decidedById` null), OPEN recommendations of those employees whose reasons no longer hold
 *    (`dismissReason` NO_LONGER_APPLIES) or whose course was assigned another way (ALREADY_ASSIGNED).
 *
 * Permissions: reading `training.view`, generating / accepting / dismissing `training.assign`, all over the employee.
 */

export const SYSTEM_DISMISS_REASONS = { noLongerApplies: "NO_LONGER_APPLIES", alreadyAssigned: "ALREADY_ASSIGNED" } as const;
const OPEN_ASSIGNMENT_STATUSES = ["ASSIGNED", "IN_PROGRESS"] as const;
const withAssignment = { assignments: { select: { id: true } } } as const;

export interface GenerationResult {
  evaluatedEmployees: number;
  created: RecommendationView[];
  dismissed: RecommendationView[];
}

/**
 * One rule run inside the caller's transaction for `employeeIds` (filtered to ACTIVE employees here). `generatedById`
 * null = a system run. Every creation and system dismissal is audited with `audit` (the caller's or the system's fields).
 */
export async function generateRecommendationsInTx(
  tx: TenantTx,
  input: { tenantId: string; employeeIds: string[]; generatedById: string | null; audit: AuditContextFields; now?: Date },
): Promise<GenerationResult> {
  const { tenantId } = input;
  const now = input.now ?? new Date();
  const employees = await tx.employee.findMany({ where: { tenantId, id: { in: input.employeeIds }, status: "ACTIVE" }, select: { id: true }, orderBy: { id: "asc" } });
  const employeeIds = employees.map((employee) => employee.id);
  if (employeeIds.length === 0) return { evaluatedEmployees: 0, created: [], dismissed: [] };

  const calendar = await tenantCalendar(tx, tenantId, now);
  const found = await evaluateRecommendationRules(tx, tenantId, employeeIds, { ...calendar, now });
  const openAssignments = new Set(
    (
      await tx.trainingAssignment.findMany({
        where: { tenantId, employeeId: { in: employeeIds }, status: { in: [...OPEN_ASSIGNMENT_STATUSES] } },
        select: { employeeId: true, courseId: true },
      })
    ).map((row) => pairKey(row.employeeId, row.courseId)),
  );
  const existing = await tx.trainingRecommendation.findMany({ where: { tenantId, employeeId: { in: employeeIds } } });

  // System dismissals first, so a pair whose old OPEN recommendation lapses can get a fresh one in the same run.
  const dismissed: RecommendationView[] = [];
  const stillOpen = new Set<string>();
  for (const recommendation of existing.filter((row) => row.status === "OPEN")) {
    const key = pairKey(recommendation.employeeId, recommendation.courseId);
    const reason = openAssignments.has(key) ? SYSTEM_DISMISS_REASONS.alreadyAssigned : found.has(key) ? null : SYSTEM_DISMISS_REASONS.noLongerApplies;
    if (!reason) {
      stillOpen.add(key);
      continue;
    }
    const after = await tx.trainingRecommendation.update({
      where: { id: recommendation.id },
      data: { status: "DISMISSED", decidedAt: now, dismissReason: reason },
      include: withAssignment,
    });
    await recordAudit(tx, {
      ...input.audit,
      action: "training_recommendation.dismiss",
      targetType: "TrainingRecommendation",
      targetId: after.id,
      previousValue: { status: "OPEN" },
      newValue: { status: "DISMISSED", dismissReason: reason, bySystem: true },
    });
    dismissed.push(toRecommendationView(after));
  }

  const covered = new Map<string, Set<string>>();
  for (const decided of existing.filter((row) => row.status !== "OPEN" && row.decidedById !== null)) {
    const key = pairKey(decided.employeeId, decided.courseId);
    const identities = covered.get(key) ?? new Set<string>();
    for (const reason of decided.reasons as unknown as RecommendationReason[]) identities.add(reasonIdentity(reason));
    covered.set(key, identities);
  }

  const created: RecommendationView[] = [];
  for (const [key, pair] of found) {
    if (stillOpen.has(key) || openAssignments.has(key)) continue;
    const alreadyDecided = covered.get(key);
    if (alreadyDecided && pair.reasons.every((reason) => alreadyDecided.has(reasonIdentity(reason)))) continue;
    // ON CONFLICT DO NOTHING: a concurrent run that created the same OPEN recommendation wins (partial unique index).
    const [row] = await tx.trainingRecommendation.createManyAndReturn({
      data: [{ tenantId, employeeId: pair.employeeId, courseId: pair.courseId, reasons: pair.reasons as unknown as Prisma.InputJsonArray, generatedById: input.generatedById, generatedAt: now }],
      skipDuplicates: true,
    });
    if (!row) continue;
    await recordAudit(tx, {
      ...input.audit,
      action: "training_recommendation.create",
      targetType: "TrainingRecommendation",
      targetId: row.id,
      newValue: { employeeId: row.employeeId, courseId: row.courseId, reasons: pair.reasons },
    });
    created.push(toRecommendationView({ ...row, assignments: [] }));
  }
  return { evaluatedEmployees: employeeIds.length, created, dismissed };
}

/**
 * `POST /training/recommendations/generate`: runs the rules for one employee (`employeeId`) or for every ACTIVE employee
 * in the caller's `training.assign` scope. The caller is `generatedById`.
 */
export async function generateRecommendations(actor: Actor, ctx: RequestContext, input: GenerateRecommendationsInput): Promise<GenerationResult> {
  return withTenant(actor.tenantId, async (tx) => {
    let employeeIds: string[];
    if (input.employeeId) {
      await enforceOverEmployee(tx, actor, "training.assign", input.employeeId);
      employeeIds = [input.employeeId];
    } else {
      await enforceInTx(tx, actor, "training.assign");
      const now = new Date();
      const scope = await resolveScope(tx, actor, "training.assign", now);
      const rows = await tx.employee.findMany({
        where: withinScope(buildScopeWhere(scope, employeeScopeColumns, now), { tenantId: actor.tenantId, status: "ACTIVE" }),
        select: { id: true },
      });
      employeeIds = rows.map((row) => row.id);
    }
    return generateRecommendationsInTx(tx, { tenantId: actor.tenantId, employeeIds, generatedById: actor.userId, audit: auditContextFields(ctx) });
  });
}

/**
 * The system run for a whole tenant (a worker calls it; this module has no scheduler). No actor: `generatedById` is null
 * and the audit events are SYSTEM events (no actor).
 */
export async function generateTrainingRecommendationsForTenant(tenantId: string, options: { now?: Date } = {}): Promise<GenerationResult> {
  const employees = await withTenant(tenantId, (tx) => tx.employee.findMany({ where: { tenantId, status: "ACTIVE" }, select: { id: true } }));
  return withTenant(tenantId, (tx) =>
    generateRecommendationsInTx(tx, {
      tenantId,
      employeeIds: employees.map((employee) => employee.id),
      generatedById: null,
      audit: { tenantId, actorUserId: null, sourceApp: "SYSTEM" },
      now: options.now,
    }),
  );
}

/** `generateTrainingRecommendationsForTenant` for every tenant (or the given ones); one tenant failing does not stop the rest. */
export async function generateAllTrainingRecommendations(options: { now?: Date; tenantIds?: readonly string[] } = {}): Promise<{ created: number; dismissed: number }> {
  const tenants = await prisma.tenant.findMany({ where: options.tenantIds ? { id: { in: [...options.tenantIds] } } : {}, select: { id: true } });
  const total = { created: 0, dismissed: 0 };
  for (const tenant of tenants) {
    try {
      const result = await generateTrainingRecommendationsForTenant(tenant.id, options);
      total.created += result.created.length;
      total.dismissed += result.dismissed.length;
    } catch (error) {
      logger.error("training recommendation run failed for a tenant", { tenantId: tenant.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return total;
}

/** Loads (and locks) an OPEN recommendation the actor may decide (`training.assign` over its employee). */
async function loadOpenForDecision(tx: TenantTx, actor: Actor, recommendationId: string): Promise<TrainingRecommendation> {
  await enforceInTx(tx, actor, "training.assign");
  await lockRow(tx, "TrainingRecommendation", actor.tenantId, recommendationId);
  const row = await tx.trainingRecommendation.findFirstOrThrow({ where: { id: recommendationId, tenantId: actor.tenantId } });
  await enforceOverEmployee(tx, actor, "training.view", row.employeeId);
  await enforceOverEmployee(tx, actor, "training.assign", row.employeeId);
  // P5-R2: a recommendation about the caller is decided by their management chain, not by them.
  if (isAboutCaller(actor, row.employeeId)) throw new ForbiddenError({ message: "You cannot decide a training recommendation about yourself." });
  if (row.status !== "OPEN") throw new InvalidStateTransitionError({ message: `This recommendation is already ${row.status.toLowerCase()}.` });
  return row;
}

/**
 * `POST /training/recommendations/{id}/accept`: OPEN -> ACCEPTED and, in the same transaction, a training assignment with
 * source RECOMMENDATION (the employee is notified). With `planId`, also a TRAINING action for it in that plan
 * (`development_plans.edit` over the employee; the plan must be the same employee's and DRAFT or ACTIVE). An open
 * assignment of the course already existing is a 409 and changes nothing.
 */
export async function acceptRecommendation(actor: Actor, ctx: RequestContext, recommendationId: string, input: AcceptRecommendationInput): Promise<RecommendationView> {
  const { view, notificationIds } = await conflictOnUniqueViolation(TRAINING_ASSIGNMENT_ALREADY_OPEN, () =>
    withTenant(actor.tenantId, async (tx) => {
      const before = await loadOpenForDecision(tx, actor, recommendationId);
      const after = await tx.trainingRecommendation.update({
        where: { id: before.id },
        data: { status: "ACCEPTED", decidedById: actor.userId, decidedAt: new Date() },
      });
      const { assignment, notificationIds: ids } = await createTrainingAssignmentInTx(tx, ctx, {
        employeeId: before.employeeId,
        courseId: before.courseId,
        dueDate: input.dueDate ?? null,
        note: input.note ?? null,
        source: "RECOMMENDATION",
        recommendationId: before.id,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "training_recommendation.accept",
        targetType: "TrainingRecommendation",
        targetId: before.id,
        previousValue: { status: before.status },
        newValue: { status: after.status, trainingAssignmentId: assignment.id, planId: input.planId ?? null },
      });
      if (input.planId) {
        const plan = await loadPlanForChange(tx, actor, input.planId).catch((error: unknown) => {
          // A plan the caller cannot change is an input problem of this request, not a missing recommendation.
          if (error instanceof NotFoundError) throw new ValidationError({ message: "Unknown development plan.", field: "planId" });
          throw error;
        });
        if (plan.employeeId !== before.employeeId) throw new ValidationError({ message: "The plan is about another employee.", field: "planId" });
        assertChangeable(plan);
        await addActionInTx(tx, actor, ctx, plan, {
          kind: "TRAINING",
          description: "Recommended training",
          trainingAssignmentId: assignment.id,
          goalId: input.goalId,
          dueDate: input.dueDate,
        });
      }
      return { view: toRecommendationView({ ...after, assignments: [{ id: assignment.id }] }), notificationIds: ids };
    }),
  );
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return view;
}

/** `POST /training/recommendations/{id}/dismiss`: OPEN -> DISMISSED with the person's reason (audited as a digest). */
export async function dismissRecommendation(actor: Actor, ctx: RequestContext, recommendationId: string, input: DismissRecommendationInput): Promise<RecommendationView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadOpenForDecision(tx, actor, recommendationId);
    const after = await tx.trainingRecommendation.update({
      where: { id: before.id },
      data: { status: "DISMISSED", decidedById: actor.userId, decidedAt: new Date(), dismissReason: input.reason },
      include: withAssignment,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_recommendation.dismiss",
      targetType: "TrainingRecommendation",
      targetId: after.id,
      previousValue: { status: before.status },
      newValue: { status: after.status, dismissReasonSha256: textDigest(input.reason), bySystem: false },
    });
    return toRecommendationView(after);
  });
}

/** `GET /training/recommendations/{id}` (`training.view` over the employee; out of scope 404). */
export async function getRecommendation(actor: Actor, recommendationId: string): Promise<RecommendationView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const row = await tx.trainingRecommendation.findFirst({ where: { id: recommendationId, tenantId: actor.tenantId }, include: withAssignment });
    if (!row) throw new NotFoundError();
    await enforceOverEmployee(tx, actor, "training.view", row.employeeId);
    return toRecommendationView(row);
  });
}

/** `GET /training/recommendations`: in the caller's `training.view` scope, newest first. */
export async function listRecommendations(actor: Actor, query: ListRecommendationsQuery): Promise<Page<RecommendationView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "training.view");
    const now = new Date();
    // Training data has one field set (`base`), as in the training module: a grant limited to another set reads nothing.
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "training.view", now), "base");
    const callerWhere: Prisma.TrainingRecommendationWhereInput = {
      tenantId: actor.tenantId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.courseId ? { courseId: query.courseId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const rows = await tx.trainingRecommendation.findMany({
      where: withinScope(buildScopeWhere(scope, recommendationScopeColumns, now), callerWhere),
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      include: withAssignment,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toRecommendationView), page: page.page };
  });
}
