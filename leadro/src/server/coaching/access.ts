import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { employeeScopeColumns, type AccessDecision, type ScopeColumns } from "@/server/authz";
import { ForbiddenError, ValidationError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * Shared rules of the coaching module. Every record here is ABOUT an employee, so its data scope is the employee's
 * (org placements, legal employer, OWN), exactly like qualification records.
 */

/** The `performance.coaching_fields` set (tag `coaching`): context notes are coaching content (spec 22.2). */
export const COACHING_FIELD_SET = "coaching";

/** Scope columns of a model that has an `employee` relation: the employee's own scope rules apply. */
export function viaEmployee<W extends object>(wrap: (employee: Prisma.EmployeeWhereInput) => W): ScopeColumns<W> {
  return {
    orgUnit: (orgUnitIds, now) => wrap(employeeScopeColumns.orgUnit?.(orgUnitIds, now) ?? { id: { in: [] } }),
    legalEntity: (legalEntityIds, now) => wrap(employeeScopeColumns.legalEntity?.(legalEntityIds, now) ?? { id: { in: [] } }),
    own: (employeeId, now) => wrap(employeeScopeColumns.own?.(employeeId, now) ?? { id: { in: [] } }),
  };
}

/**
 * A plain `performance.view` / `.edit` grant never reveals coaching content: the grant that matched must name the
 * `coaching` set (opt-in sensitive category). Without it the note is treated as not visible.
 */
export function assertCoachingFields(decision: AccessDecision): void {
  if (!decision.fieldSets.includes(COACHING_FIELD_SET)) throw new ForbiddenError();
}

/** Nobody writes coaching or context notes about themselves (they are a manager's or HR's view of the person). */
export function assertNotAboutSelf(actor: Actor, employeeId: string): void {
  if (actor.employeeId === employeeId) {
    throw new ForbiddenError({ message: "You cannot write coaching or context notes about yourself." });
  }
}

/**
 * Free text is never audited (spec 22.2: audit readers do not necessarily hold the coaching set). An audit event that
 * records a text change carries this SHA-256 digest instead, so a reader can tell THAT and WHEN the text changed and match
 * it to a version, without reading it.
 */
export const textDigest = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");

/** A metric value's owner and period, read straight from its table (the performance module owns computing them). */
export async function loadMetricValueFacts(
  tx: TenantTx,
  tenantId: string,
  metricValueId: string,
): Promise<{ id: string; employeeId: string; periodStart: Date; periodEnd: Date } | null> {
  return tx.performanceMetricValue.findFirst({
    where: { id: metricValueId, tenantId },
    select: { id: true, employeeId: true, periodStart: true, periodEnd: true },
  });
}

/** The metric value must exist and be the same employee's (the composite FK refuses it too; this gives a 400, not a 500). */
export async function assertMetricValueOfEmployee(tx: TenantTx, tenantId: string, metricValueId: string, employeeId: string): Promise<void> {
  const value = await loadMetricValueFacts(tx, tenantId, metricValueId);
  if (!value || value.employeeId !== employeeId) {
    throw new ValidationError({ message: "The metric value does not exist or is not this employee's.", field: "metricValueId" });
  }
}

/** Takes the row lock of one note, so concurrent share / archive / edit calls serialize and re-read after it. */
export async function lockRow(tx: TenantTx, table: "CoachingRecord" | "MetricContextNote", id: string, tenantId: string): Promise<void> {
  if (table === "CoachingRecord") {
    await tx.$queryRaw`SELECT "id" FROM "CoachingRecord" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "MetricContextNote" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  }
}
