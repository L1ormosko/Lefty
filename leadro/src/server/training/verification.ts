import type { TrainingRecord } from "@prisma/client";
import { localIsoDate } from "@/lib/zoned-time";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { InvalidStateTransitionError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { grantTrainingQualificationInTx, restateTrainingQualificationInTx, type TrainingQualificationBasis } from "@/server/qualifications";
import { assertNotOwnRecord, enforceOverEmployee, lockRow, tenantCalendar } from "./access";
import { isoDateOf, toRecordView, type RecordView } from "./views";

/**
 * HR's decisions on a training record (§5.8): verify, reject, revoke. Each needs `training.approve` over the employee,
 * never on one's own record (§21.3), and is audited with the previous and new status.
 *
 * Verifying (PENDING_VERIFICATION -> VERIFIED), in the same transaction:
 *  - completes the employee's open assignment of the course (COMPLETED, linked to this record);
 *  - when the course grants a TRAINING certification and the completion has not already expired, creates or renews the
 *    employee's TRAINING qualification through the qualifications module (so the eligibility engine sees it) and stores
 *    its id on the record. An already-expired completion is verified as history only.
 *
 * Revoking (VERIFIED -> REVOKED) re-derives that qualification from the employee's remaining verified records of courses
 * granting it: none left -> the qualification is revoked; otherwise its dates follow the best remaining record. A
 * COMPLETED assignment stays completed (history); assign the course again if needed.
 */

/** Loads and locks the record for a decision: capability (403), scope (404), separation of duties (403). */
async function loadForDecision(tx: TenantTx, actor: Actor, recordId: string): Promise<TrainingRecord> {
  await enforceInTx(tx, actor, "training.approve");
  await lockRow(tx, "TrainingRecord", actor.tenantId, recordId);
  const row = await tx.trainingRecord.findFirstOrThrow({ where: { id: recordId, tenantId: actor.tenantId } });
  await enforceOverEmployee(tx, actor, "training.approve", row.employeeId);
  await assertNotOwnRecord(tx, actor, row.employeeId);
  return row;
}

function refuse(row: TrainingRecord, target: string): never {
  throw new InvalidStateTransitionError({ message: `A ${row.status.toLowerCase().replace("_", " ")} training record cannot be ${target}.` });
}

/** `POST /training/records/{id}/verify`. */
export async function verifyRecord(actor: Actor, ctx: RequestContext, recordId: string): Promise<RecordView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForDecision(tx, actor, recordId);
    if (before.status !== "PENDING_VERIFICATION") refuse(before, "verified");
    const now = new Date();
    const { timeZone, today } = await tenantCalendar(tx, actor.tenantId, now);
    const course = await tx.trainingCourse.findFirstOrThrow({ where: { id: before.courseId, tenantId: actor.tenantId }, select: { certificationId: true } });

    const expiresOn = isoDateOf(before.expiresAt);
    let qualification: { qualificationId: string; outcome: string } | null = null;
    if (course.certificationId && (expiresOn === null || expiresOn >= today)) {
      qualification = await grantTrainingQualificationInTx(tx, ctx, {
        employeeId: before.employeeId,
        certificationId: course.certificationId,
        completedOn: localIsoDate(before.completedAt.getTime(), timeZone),
        expiresOn,
        trainingRecordId: before.id,
      });
    }
    const row = await tx.trainingRecord.update({
      where: { id: before.id },
      data: { status: "VERIFIED", verifiedById: actor.userId, verifiedAt: now, qualificationId: qualification?.qualificationId ?? null },
    });

    const open = await tx.trainingAssignment.findFirst({
      where: { tenantId: actor.tenantId, employeeId: row.employeeId, courseId: row.courseId, status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
    });
    if (open) {
      await tx.trainingAssignment.update({ where: { id: open.id }, data: { status: "COMPLETED", completedAt: now, trainingRecordId: row.id } });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "training_assignment.complete",
        targetType: "TrainingAssignment",
        targetId: open.id,
        previousValue: { status: open.status },
        newValue: { status: "COMPLETED", trainingRecordId: row.id },
      });
    }
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_record.verify",
      targetType: "TrainingRecord",
      targetId: row.id,
      previousValue: { status: before.status },
      newValue: {
        status: row.status,
        qualificationId: row.qualificationId,
        qualificationOutcome: qualification?.outcome ?? (course.certificationId ? "EXPIRED" : "NONE"),
        completedAssignmentId: open?.id ?? null,
      },
    });
    return toRecordView(row);
  });
}

/** `POST /training/records/{id}/reject`: PENDING_VERIFICATION -> REJECTED with a reason. */
export async function rejectRecord(actor: Actor, ctx: RequestContext, recordId: string, reason: string): Promise<RecordView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForDecision(tx, actor, recordId);
    if (before.status !== "PENDING_VERIFICATION") refuse(before, "rejected");
    const row = await tx.trainingRecord.update({
      where: { id: before.id },
      data: { status: "REJECTED", verifiedById: actor.userId, verifiedAt: new Date(), decisionReason: reason },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_record.reject",
      targetType: "TrainingRecord",
      targetId: row.id,
      previousValue: { status: before.status },
      newValue: { status: row.status },
      reason,
    });
    return toRecordView(row);
  });
}

/** The best remaining support of a qualification: the latest expiry wins, "never expires" beats every date. */
function bestBasis(records: Array<Pick<TrainingRecord, "completedAt" | "expiresAt">>, timeZone: string): TrainingQualificationBasis | null {
  let best: TrainingQualificationBasis | null = null;
  for (const record of records) {
    const candidate = { completedOn: localIsoDate(record.completedAt.getTime(), timeZone), expiresOn: isoDateOf(record.expiresAt) };
    const better =
      best === null ||
      (best.expiresOn !== null && (candidate.expiresOn === null || candidate.expiresOn > best.expiresOn)) ||
      (best.expiresOn === candidate.expiresOn && candidate.completedOn > best.completedOn);
    if (better) best = candidate;
  }
  return best;
}

/** `POST /training/records/{id}/revoke`: VERIFIED -> REVOKED with a reason; the qualification it supported follows. */
export async function revokeRecord(actor: Actor, ctx: RequestContext, recordId: string, reason: string): Promise<RecordView> {
  return withTenant(actor.tenantId, async (tx) => {
    const before = await loadForDecision(tx, actor, recordId);
    if (before.status !== "VERIFIED") refuse(before, "revoked");
    const row = await tx.trainingRecord.update({ where: { id: before.id }, data: { status: "REVOKED", decisionReason: reason } });

    let qualificationOutcome: string | null = null;
    if (before.qualificationId) {
      const { timeZone } = await tenantCalendar(tx, actor.tenantId);
      const remaining = await tx.trainingRecord.findMany({
        where: { tenantId: actor.tenantId, qualificationId: before.qualificationId, status: "VERIFIED", id: { not: before.id } },
        select: { completedAt: true, expiresAt: true },
      });
      qualificationOutcome = await restateTrainingQualificationInTx(tx, ctx, {
        qualificationId: before.qualificationId,
        basis: bestBasis(remaining, timeZone),
        reason,
      });
    }
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "training_record.revoke",
      targetType: "TrainingRecord",
      targetId: row.id,
      previousValue: { status: before.status },
      newValue: { status: row.status, qualificationId: row.qualificationId, qualificationOutcome },
      reason,
    });
    return toRecordView(row);
  });
}
