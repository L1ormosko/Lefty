import { auditContextFields, recordAudit } from "@/server/audit";
import { ValidationError, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * TRAINING qualifications that come from verified training records (§10.1 "Training", Phase 5 Task 2). The training
 * module calls these inside its own transaction after HR verified (or revoked) a completion of a course that grants a
 * TRAINING-type certification, so the eligibility engine sees the result like any other verified credential.
 *
 * These functions do NOT check permissions: the training module has already enforced `training.approve` over the
 * employee and separation of duties. They write their own audit events (`qualification.training_grant`,
 * `qualification.training_renew`, `qualification.training_restate`, `qualification.revoke`).
 */

/** The dates a completion supports: `YYYY-MM-DD`, tenant-local. `expiresOn` null = does not expire. */
export interface TrainingQualificationBasis {
  completedOn: string;
  expiresOn: string | null;
}

export interface GrantTrainingQualificationInput extends TrainingQualificationBasis {
  employeeId: string;
  /** A TRAINING-type certification (the composite FK on (certificationId, kind) refuses any other type). */
  certificationId: string;
  /** The training record this comes from (audit only). */
  trainingRecordId: string;
}

export type TrainingGrantOutcome = "CREATED" | "RENEWED" | "UNCHANGED";

const asDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);
const isoOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

/** Does expiry `candidate` reach further than `current`? Null means "never expires", which beats any date. */
function extendsExpiry(current: string | null, candidate: string | null): boolean {
  if (current === null) return false;
  if (candidate === null) return true;
  return candidate > current;
}

/**
 * Creates or renews the employee's TRAINING qualification for `certificationId`, VERIFIED by the context's actor:
 *
 * - an existing VERIFIED record is renewed (issue and expiry dates moved) only when the new expiry reaches further,
 *   so verifying an older completion never shortens a newer one (`UNCHANGED` then);
 * - an existing PENDING_VERIFICATION record (recorded by hand) is verified with the completion's dates (`RENEWED`);
 * - otherwise (none, or only REJECTED / REVOKED history, which stays as it is) a new VERIFIED record is created.
 *
 * @returns the qualification id to store on the training record, and what happened.
 * @throws ValidationError when the certification is unknown or not of type TRAINING
 */
export async function grantTrainingQualificationInTx(
  tx: TenantTx,
  ctx: RequestContext,
  input: GrantTrainingQualificationInput,
): Promise<{ qualificationId: string; outcome: TrainingGrantOutcome }> {
  if (!ctx.actor) throw new Error("grantTrainingQualificationInTx requires an authenticated actor");
  const { tenantId, userId } = ctx.actor;
  const certification = await tx.certification.findFirst({ where: { id: input.certificationId, tenantId }, select: { type: true } });
  if (!certification || certification.type !== "TRAINING") {
    throw new ValidationError({ message: "The course's certification is not a training certification.", field: "certificationId" });
  }
  if (input.expiresOn !== null && input.expiresOn <= input.completedOn) {
    throw new ValidationError({ message: "The expiry date must be after the completion date.", field: "expiresOn" });
  }

  const existing = await tx.employeeQualification.findMany({
    where: { tenantId, employeeId: input.employeeId, certificationId: input.certificationId, status: { in: ["VERIFIED", "PENDING_VERIFICATION"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const verified = existing.find((row) => row.status === "VERIFIED");
  const pending = existing.find((row) => row.status === "PENDING_VERIFICATION");
  const now = new Date();
  const dates = { issuedAt: asDate(input.completedOn), expiresAt: input.expiresOn ? asDate(input.expiresOn) : null };
  const audit = { ...auditContextFields(ctx), targetType: "EmployeeQualification" };

  const target = verified ?? pending;
  if (target) {
    if (target.status === "VERIFIED" && !extendsExpiry(isoOf(target.expiresAt), input.expiresOn)) {
      return { qualificationId: target.id, outcome: "UNCHANGED" };
    }
    await tx.employeeQualification.update({
      where: { id: target.id },
      data: { ...dates, status: "VERIFIED", verifiedById: userId, verifiedAt: now },
    });
    await recordAudit(tx, {
      ...audit,
      action: "qualification.training_renew",
      targetId: target.id,
      previousValue: { status: target.status, issuedAt: isoOf(target.issuedAt), expiresAt: isoOf(target.expiresAt) },
      newValue: { status: "VERIFIED", issuedAt: input.completedOn, expiresAt: input.expiresOn, trainingRecordId: input.trainingRecordId },
    });
    return { qualificationId: target.id, outcome: "RENEWED" };
  }

  const row = await tx.employeeQualification.create({
    data: {
      tenantId,
      employeeId: input.employeeId,
      kind: "TRAINING",
      certificationId: input.certificationId,
      ...dates,
      status: "VERIFIED",
      verifiedById: userId,
      verifiedAt: now,
    },
  });
  await recordAudit(tx, {
    ...audit,
    action: "qualification.training_grant",
    targetId: row.id,
    newValue: { kind: "TRAINING", certificationId: input.certificationId, issuedAt: input.completedOn, expiresAt: input.expiresOn, status: "VERIFIED", trainingRecordId: input.trainingRecordId },
  });
  return { qualificationId: row.id, outcome: "CREATED" };
}

/**
 * After a training record behind a TRAINING qualification was revoked: with `basis` null (no other verified record
 * supports it) the qualification is REVOKED with `reason`; otherwise its dates are set to `basis` (the best remaining
 * record), which may shorten them. A qualification that is no longer VERIFIED (HR already changed it by hand) is left
 * alone. Returns what happened.
 */
export async function restateTrainingQualificationInTx(
  tx: TenantTx,
  ctx: RequestContext,
  input: { qualificationId: string; basis: TrainingQualificationBasis | null; reason: string },
): Promise<"REVOKED" | "RESTATED" | "UNCHANGED"> {
  if (!ctx.actor) throw new Error("restateTrainingQualificationInTx requires an authenticated actor");
  const row = await tx.employeeQualification.findFirst({ where: { id: input.qualificationId, tenantId: ctx.actor.tenantId } });
  if (!row || row.status !== "VERIFIED") return "UNCHANGED";
  const audit = { ...auditContextFields(ctx), targetType: "EmployeeQualification", targetId: row.id, reason: input.reason };

  if (input.basis === null) {
    await tx.employeeQualification.update({ where: { id: row.id }, data: { status: "REVOKED", verifiedById: null, verifiedAt: null } });
    await recordAudit(tx, { ...audit, action: "qualification.revoke", previousValue: { status: row.status }, newValue: { status: "REVOKED" } });
    return "REVOKED";
  }
  const next = { issuedAt: input.basis.completedOn, expiresAt: input.basis.expiresOn };
  const previous = { issuedAt: isoOf(row.issuedAt), expiresAt: isoOf(row.expiresAt) };
  if (previous.issuedAt === next.issuedAt && previous.expiresAt === next.expiresAt) return "UNCHANGED";
  await tx.employeeQualification.update({
    where: { id: row.id },
    data: { issuedAt: asDate(next.issuedAt), expiresAt: next.expiresAt ? asDate(next.expiresAt) : null },
  });
  await recordAudit(tx, { ...audit, action: "qualification.training_restate", previousValue: previous, newValue: next });
  return "RESTATED";
}
