import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, openEndedWhere, resolveScope, withinScope } from "@/server/authz";
import {
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  ValidationError,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant } from "@/server/db";
import type { CreateJobPermissionInput, EndGrantInput, ListByEmployeeQuery } from "./schemas";
import { endInstant } from "./grant-window";
import { assertBaseFields, jobPermissionScopeColumns, toJobPermissionView } from "./views";

/**
 * Job-category permissions (§10.1): authorization to take jobs of one job type OR one category, for a
 * period. A matching permission in force is a HARD requirement of eligibility. Granting authorization
 * is an approval decision, so it needs `qualifications.approve` (HR / Owner) over the employee, not
 * the `edit` that managers hold; the grantor is recorded on the row. Rows are ended, never deleted.
 */

type JobPermissionView = ReturnType<typeof toJobPermissionView>;

export async function grantJobPermission(actor: Actor, ctx: RequestContext, input: CreateJobPermissionInput): Promise<JobPermissionView> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "qualifications.approve", { employeeId: input.employeeId });
    assertBaseFields(decision);
    const employee = await tx.employee.findFirst({ where: { id: input.employeeId, tenantId: actor.tenantId }, select: { status: true } });
    if (!employee) throw new NotFoundError();
    if (employee.status === "TERMINATED") throw new InvalidStateTransitionError({ message: "A terminated employee's permissions cannot be changed." });

    if (input.jobTypeId) {
      const jobType = await tx.jobType.findFirst({ where: { id: input.jobTypeId, tenantId: actor.tenantId }, select: { active: true } });
      if (!jobType) throw new ValidationError({ message: "Unknown job type.", field: "jobTypeId" });
      if (!jobType.active) throw new ValidationError({ message: "This job type is retired.", field: "jobTypeId" });
    }
    const row = await tx.employeeJobPermission.create({
      data: {
        tenantId: actor.tenantId,
        employeeId: input.employeeId,
        jobTypeId: input.jobTypeId,
        category: input.category,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        effectiveTo: input.effectiveTo,
        grantedById: actor.userId,
        reason: input.reason,
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "job_permission.grant",
      targetType: "EmployeeJobPermission",
      targetId: row.id,
      newValue: { employeeId: input.employeeId, jobTypeId: input.jobTypeId ?? null, category: input.category ?? null, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo },
      reason: input.reason,
    });
    return toJobPermissionView(row);
  });
}

export async function endJobPermission(actor: Actor, ctx: RequestContext, permissionId: string, input: EndGrantInput): Promise<JobPermissionView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.approve");
    const row = await tx.employeeJobPermission.findFirst({ where: { id: permissionId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "qualifications.approve", { employeeId: row.employeeId });
    assertBaseFields(decision);
    const now = new Date();
    if (row.effectiveTo && row.effectiveTo.getTime() <= now.getTime()) {
      throw new InvalidStateTransitionError({ message: "This permission has already ended." });
    }
    const updated = await tx.employeeJobPermission.update({ where: { id: row.id }, data: { effectiveTo: endInstant(row.effectiveFrom, now) } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "job_permission.end",
      targetType: "EmployeeJobPermission",
      targetId: row.id,
      previousValue: { effectiveTo: row.effectiveTo },
      newValue: { effectiveTo: updated.effectiveTo },
      reason: input.reason,
    });
    return toJobPermissionView(updated);
  });
}

/** One employee's job permissions (`qualifications.view` over them), oldest first. */
export async function listJobPermissions(actor: Actor, query: ListByEmployeeQuery): Promise<Page<JobPermissionView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const now = new Date();
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "qualifications.view", now), "base");
    const callerWhere: Prisma.EmployeeJobPermissionWhereInput = {
      tenantId: actor.tenantId,
      employeeId: query.employeeId,
      ...(query.activeOnly ? { effectiveFrom: { lte: now }, ...openEndedWhere(now) } : {}),
    };
    const rows = await tx.employeeJobPermission.findMany({
      where: withinScope(buildScopeWhere(scope, jobPermissionScopeColumns, now), callerWhere),
      orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toJobPermissionView), page: page.page };
  });
}
