import type { DataChallenge, Prisma } from "@prisma/client";
import { NotFoundError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import type { DataChallengeTargetTypeName } from "./schemas";

/**
 * The records an employee may challenge (spec 10.4, 5.8 "employee-submitted corrections"). Each target is read straight from
 * its own table inside the challenge's transaction (the owning modules are not asked: this only checks WHOSE record it is
 * and whether the employee can see it).
 *
 * Visible-to-the-employee rules (docs/ERD.md "Documented rules not expressible in the database"):
 * - a metric value only when its definition is PUBLISHED (employees never see drafts or retired versions);
 * - a coaching note only when it is shared with them and not archived;
 * - training records and qualifications are always their own to see.
 * Anything else, including another employee's record, is "not found" (no existence leak).
 */

/** The typed FK column of each target type (one nullable column per type, DB CHECK `data_challenge_target_matches_type`). */
export const TARGET_COLUMN = {
  PERFORMANCE_METRIC_VALUE: "metricValueId",
  TRAINING_RECORD: "trainingRecordId",
  COACHING_RECORD: "coachingRecordId",
  EMPLOYEE_QUALIFICATION: "qualificationId",
} as const satisfies Record<DataChallengeTargetTypeName, keyof DataChallenge>;

/** The id of the record a challenge is about. */
export function targetIdOf(challenge: Pick<DataChallenge, "targetType" | "metricValueId" | "trainingRecordId" | "coachingRecordId" | "qualificationId">): string {
  const value = challenge[TARGET_COLUMN[challenge.targetType]];
  // The DB CHECK guarantees the declared column is set.
  return value as string;
}

/** The create-data fragment that points a new challenge at its target. */
export function targetColumns(targetType: DataChallengeTargetTypeName, targetId: string): Pick<Prisma.DataChallengeUncheckedCreateInput, "metricValueId" | "trainingRecordId" | "coachingRecordId" | "qualificationId"> {
  return { [TARGET_COLUMN[targetType]]: targetId };
}

/**
 * Confirms the target exists, belongs to `employeeId` and is visible to that employee. Throws NotFoundError otherwise.
 */
export async function assertChallengeableByEmployee(
  tx: TenantTx,
  tenantId: string,
  employeeId: string,
  targetType: DataChallengeTargetTypeName,
  targetId: string,
): Promise<void> {
  const where = { id: targetId, tenantId, employeeId };
  let visible: boolean;
  switch (targetType) {
    case "PERFORMANCE_METRIC_VALUE": {
      const value = await tx.performanceMetricValue.findFirst({ where, select: { definition: { select: { status: true } } } });
      visible = value?.definition.status === "PUBLISHED";
      break;
    }
    case "TRAINING_RECORD":
      visible = (await tx.trainingRecord.count({ where })) === 1;
      break;
    case "COACHING_RECORD":
      visible = (await tx.coachingRecord.count({ where: { ...where, sharedWithEmployee: true, archivedAt: null } })) === 1;
      break;
    case "EMPLOYEE_QUALIFICATION":
      visible = (await tx.employeeQualification.count({ where })) === 1;
      break;
  }
  if (!visible) throw new NotFoundError();
}

/**
 * How a CORRECTED resolution is proven, per target type (see `upholdDataChallengeSchema`):
 * - `in_transaction`: this module calls the owning module's correction API inside the decision's transaction;
 * - `audit_reference`: the owning module's existing endpoints made the correction, and the reviewer names its audit event,
 *   which must be about the challenged record (`auditTargetType` + id), succeeded, happened after the challenge was raised, and
 *   is one of the correcting actions (`actions` when listed, else any action starting with `actionPrefix`);
 * - `none`: no correction API exists yet, so the challenge can only be annotated (hand-off in docs/DECISIONS.md "Phase 5 Task 4").
 */
export const CORRECTION_PATH: Record<
  DataChallengeTargetTypeName,
  | { kind: "in_transaction" }
  | { kind: "audit_reference"; auditTargetType: string; actionPrefix: string; actions?: readonly string[] }
  | { kind: "none" }
> = {
  COACHING_RECORD: { kind: "in_transaction" },
  EMPLOYEE_QUALIFICATION: { kind: "audit_reference", auditTargetType: "EmployeeQualification", actionPrefix: "qualification." },
  PERFORMANCE_METRIC_VALUE: { kind: "none" },
  // A training record's completion is frozen once recorded, so HR "corrects" a wrong one by rejecting it (still pending) or
  // revoking it (verified) through `/api/v1/training/records/{id}/reject|revoke`; the employee or manager then records the
  // right completion. Only those two actions count: a verification is not a correction.
  TRAINING_RECORD: {
    kind: "audit_reference",
    auditTargetType: "TrainingRecord",
    actionPrefix: "training_record.",
    actions: ["training_record.reject", "training_record.revoke"],
  },
};
