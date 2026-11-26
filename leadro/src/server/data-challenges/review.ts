import type { DataChallenge, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { canInTx } from "@/server/authz";
import { supersedeCoachingRecordInTx } from "@/server/coaching";
import { ForbiddenError, InvalidStateTransitionError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { notifyEmployeeDecided, notifyReviewerAssigned } from "./notify";
import { loadForAction, toDataChallengeView, type DataChallengeView } from "./read";
import type { AssignDataChallengeInput, RejectDataChallengeInput, UpholdDataChallengeInput } from "./schemas";
import { CORRECTION_PATH, targetIdOf } from "./targets";

/**
 * Review of a challenge (spec 10.4, 5.8; docs/DECISIONS.md "Phase 5 Task 1" ruling 4): managers ROUTE a challenge to a
 * reviewer (`data_challenges.assign`), HR (and the Owner) DECIDE it (`data_challenges.approve` / `.reject`).
 *
 * OPEN -> UNDER_REVIEW (reviewer; re-routing keeps UNDER_REVIEW) -> UPHELD (ANNOTATED | CORRECTED) | REJECTED (reason).
 * - The reviewer must be able to decide (approve AND reject over the employee) and is never the person who raised it nor
 *   the employee (DB CHECK `data_challenge_reviewer_not_raiser` too). Only the assigned reviewer decides.
 * - A challenge never silently edits data: ANNOTATED stores the annotation shown next to the data; CORRECTED means the
 *   owning module made the correction with its own audit, and that audit event's id is stored in `resolutionDetails`.
 * - Free text (statement, annotation, reason) is never audited; it lives on the challenge row only.
 */

const DECIDE_PERMISSIONS = ["data_challenges.approve", "data_challenges.reject"] as const;

function assertStatus(challenge: DataChallenge, allowed: readonly DataChallenge["status"][], verb: string): void {
  if (!allowed.includes(challenge.status)) {
    throw new InvalidStateTransitionError({ message: `A ${challenge.status.toLowerCase().replace("_", " ")} challenge cannot be ${verb}.` });
  }
}

/** Nobody decides a challenge about themselves, and only the person it was routed to decides it. */
function assertMayDecide(actor: Actor, challenge: DataChallenge): void {
  if (actor.userId === challenge.raisedById || actor.employeeId === challenge.employeeId) {
    throw new ForbiddenError({ message: "You cannot review a challenge of your own records." });
  }
  if (challenge.reviewerId !== actor.userId) throw new ForbiddenError({ message: "Only the assigned reviewer can decide this challenge." });
}

/** Routes a challenge to a reviewer who can decide it (OPEN -> UNDER_REVIEW, or re-routes one under review). Notifies the reviewer. */
export async function assignDataChallengeReviewer(
  actor: Actor,
  ctx: RequestContext,
  challengeId: string,
  input: AssignDataChallengeInput,
): Promise<DataChallengeView> {
  const { challenge, notificationIds } = await withTenant(actor.tenantId, async (tx) => {
    const before = await loadForAction(tx, actor, challengeId, "data_challenges.assign");
    assertStatus(before, ["OPEN", "UNDER_REVIEW"], "assigned");
    if (actor.employeeId === before.employeeId) throw new ForbiddenError({ message: "You cannot route a challenge of your own records." });
    await assertEligibleReviewer(tx, before, input.reviewerUserId);
    if (before.reviewerId === input.reviewerUserId) return { challenge: before, notificationIds: [] };

    const after = await tx.dataChallenge.update({
      where: { id: before.id },
      data: { status: "UNDER_REVIEW", reviewerId: input.reviewerUserId, assignedAt: new Date() },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "data_challenge.assign",
      targetType: "DataChallenge",
      targetId: after.id,
      previousValue: { status: before.status, reviewerId: before.reviewerId },
      newValue: { status: after.status, reviewerId: after.reviewerId },
    });
    return { challenge: after, notificationIds: await notifyReviewerAssigned(tx, after, actor.userId) };
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return toDataChallengeView(challenge);
}

/**
 * A reviewer is an active user of the tenant who holds BOTH decision permissions over the employee right now, is not the
 * person who raised the challenge and is not the challenged employee. Refused as a 400 on `reviewerUserId` (the caller picked
 * the wrong person; nothing about the user's existence is revealed beyond "cannot review").
 */
async function assertEligibleReviewer(tx: TenantTx, challenge: DataChallenge, reviewerUserId: string): Promise<void> {
  const refuse = () => new ValidationError({ message: "This person cannot review this challenge.", field: "reviewerUserId" });
  if (reviewerUserId === challenge.raisedById) throw refuse();
  const reviewer = await tx.user.findFirst({ where: { id: reviewerUserId, tenantId: challenge.tenantId, status: "ACTIVE" }, select: { employee: { select: { id: true } } } });
  if (!reviewer || reviewer.employee?.id === challenge.employeeId) throw refuse();
  for (const permission of DECIDE_PERMISSIONS) {
    const decision = await canInTx(tx, { tenantId: challenge.tenantId, userId: reviewerUserId }, permission, { employeeId: challenge.employeeId });
    if (!decision.allowed) throw refuse();
  }
}

/**
 * Upholds a challenge (UNDER_REVIEW -> UPHELD) and tells the employee. ANNOTATED: `resolution` is the annotation. CORRECTED:
 * see `CORRECTION_PATH` (coaching note: corrected in this transaction through the coaching module; qualification: the named
 * audit event of the correction the reviewer made through the qualifications API; metric values and training records: refused,
 * annotate instead).
 */
export async function upholdDataChallenge(actor: Actor, ctx: RequestContext, challengeId: string, input: UpholdDataChallengeInput): Promise<DataChallengeView> {
  const { challenge, notificationIds } = await withTenant(actor.tenantId, async (tx) => {
    const before = await loadForAction(tx, actor, challengeId, "data_challenges.approve");
    assertStatus(before, ["UNDER_REVIEW"], "upheld");
    assertMayDecide(actor, before);

    const resolutionDetails = input.resolutionKind === "CORRECTED" ? await applyCorrection(tx, ctx, before, input) : null;
    const after = await tx.dataChallenge.update({
      where: { id: before.id },
      data: {
        status: "UPHELD",
        resolutionKind: input.resolutionKind,
        resolution: input.resolution,
        resolutionDetails: resolutionDetails ?? undefined,
        resolvedById: actor.userId,
        resolvedAt: new Date(),
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "data_challenge.uphold",
      targetType: "DataChallenge",
      targetId: after.id,
      previousValue: { status: before.status },
      newValue: { status: after.status, resolutionKind: after.resolutionKind, resolutionDetails },
    });
    return { challenge: after, notificationIds: await notifyEmployeeDecided(tx, after) };
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return toDataChallengeView(challenge);
}

/** Performs or verifies the owning module's correction and returns the ids that prove it (`resolutionDetails`). */
async function applyCorrection(
  tx: TenantTx,
  ctx: RequestContext,
  challenge: DataChallenge,
  input: Extract<UpholdDataChallengeInput, { resolutionKind: "CORRECTED" }>,
): Promise<Prisma.InputJsonObject> {
  const path = CORRECTION_PATH[challenge.targetType];
  const targetId = targetIdOf(challenge);
  if (path.kind === "none") {
    throw new ValidationError({
      message: "This kind of record cannot be corrected through a challenge yet; uphold it with an annotation.",
      field: "resolutionKind",
    });
  }
  if (path.kind === "in_transaction") {
    if (!input.correctedBody) throw new ValidationError({ message: "The corrected text is required.", field: "correctedBody" });
    if (input.correctionAuditEventId) throw new ValidationError({ message: "Not used for this kind of record.", field: "correctionAuditEventId" });
    const { auditEventId, correctedRecord } = await supersedeCoachingRecordInTx(tx, {
      tenantId: challenge.tenantId,
      coachingRecordId: targetId,
      employeeId: challenge.employeeId,
      body: input.correctedBody,
      challengeId: challenge.id,
      ctx,
    });
    return { auditEventId, correctedCoachingRecordId: correctedRecord.id };
  }
  // audit_reference: the owning module's own endpoint made (and audited) the change; prove it is about THIS record and
  // happened after the challenge was raised, so an unrelated or older event cannot be passed off as the correction.
  if (!input.correctionAuditEventId) {
    throw new ValidationError({ message: "Name the audit event of the correction.", field: "correctionAuditEventId" });
  }
  if (input.correctedBody) throw new ValidationError({ message: "Not used for this kind of record.", field: "correctedBody" });
  const event = await tx.auditEvent.findFirst({
    where: {
      id: input.correctionAuditEventId,
      tenantId: challenge.tenantId,
      targetType: path.auditTargetType,
      targetId,
      outcome: "SUCCESS",
      action: { startsWith: path.actionPrefix },
      occurredAt: { gte: challenge.raisedAt },
    },
    select: { id: true, action: true },
  });
  if (!event) {
    throw new ValidationError({ message: "No correction of this record was found under that audit event.", field: "correctionAuditEventId" });
  }
  return { auditEventId: event.id, action: event.action };
}

/** Rejects a challenge with a reason shown to the employee (UNDER_REVIEW -> REJECTED) and tells the employee. */
export async function rejectDataChallenge(actor: Actor, ctx: RequestContext, challengeId: string, input: RejectDataChallengeInput): Promise<DataChallengeView> {
  const { challenge, notificationIds } = await withTenant(actor.tenantId, async (tx) => {
    const before = await loadForAction(tx, actor, challengeId, "data_challenges.reject");
    assertStatus(before, ["UNDER_REVIEW"], "rejected");
    assertMayDecide(actor, before);
    const after = await tx.dataChallenge.update({
      where: { id: before.id },
      data: { status: "REJECTED", resolution: input.reason, resolvedById: actor.userId, resolvedAt: new Date() },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "data_challenge.reject",
      targetType: "DataChallenge",
      targetId: after.id,
      previousValue: { status: before.status },
      newValue: { status: after.status },
    });
    return { challenge: after, notificationIds: await notifyEmployeeDecided(tx, after) };
  });
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return toDataChallengeView(challenge);
}
