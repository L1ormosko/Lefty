import type { FollowUpTargetType } from "@prisma/client";
import { canInTx, type ResourceRef } from "@/server/authz";
import { ForbiddenError, ValidationError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { canViewTarget } from "./access";
import { targetColumns } from "./targets";

/** What the assignee check needs to know about the task, whether it exists yet (create) or not (assign). */
export interface AssignableTask {
  targetType: FollowUpTargetType;
  targetId: string;
  orgUnitId: string | null;
  /** The creator's employee record (OWN scope of the task reference); null for system-created tasks. */
  creatorEmployeeId: string | null;
}

export interface ValidAssignee {
  employeeId: string;
  userId: string;
}

/**
 * Who may be given a follow-up. `caller` is the person assigning (null = the system, e.g. the recovery engine).
 *
 *  1. The employee exists in the tenant, is ACTIVE (not on leave or terminated) and has a login: a task nobody can open is
 *     worse than none.
 *  2. Giving a task to someone else needs `follow_ups.assign` over that employee ("within the creator's employee scope":
 *     the grant's org-unit scope must cover the employee's placement). Assigning to yourself only needs the permission
 *     that lets you hold the task. An employee outside the caller's scope is reported exactly like a missing one, so the
 *     field cannot be used to discover who works elsewhere.
 *  3. The assignee must be able to work the task: `follow_ups.view` over it AND view access to its target. Otherwise the
 *     task would land in a queue they cannot open.
 */
export async function validateAssignee(
  tx: TenantTx,
  caller: Actor | null,
  tenantId: string,
  employeeId: string,
  task: AssignableTask,
): Promise<ValidAssignee> {
  const employee = await tx.employee.findFirst({ where: { id: employeeId, tenantId }, select: { id: true, status: true, userId: true } });
  const notFound = () => new ValidationError({ message: "Employee not found.", field: "assigneeId" });
  if (!employee) throw notFound();

  if (caller && caller.employeeId !== employee.id) {
    if (!(await canInTx(tx, caller, "follow_ups.assign")).allowed) throw new ForbiddenError();
    const inScope = await canInTx(tx, caller, "follow_ups.assign", { employeeId: employee.id });
    if (!inScope.allowed) throw notFound();
  }
  if (employee.status !== "ACTIVE") {
    throw new ValidationError({ message: "This employee is not available (on leave or terminated).", field: "assigneeId" });
  }
  if (!employee.userId) throw new ValidationError({ message: "This employee has no login and cannot work follow-ups.", field: "assigneeId" });

  const subject = { tenantId, userId: employee.userId };
  const ref: ResourceRef = {
    ...(task.orgUnitId ? { orgUnitId: task.orgUnitId } : {}),
    assignedEmployeeIds: [employee.id],
    ...(task.creatorEmployeeId ? { ownerEmployeeId: task.creatorEmployeeId } : {}),
  };
  const mayView = (await canInTx(tx, subject, "follow_ups.view", ref)).allowed;
  const mayViewTarget = await canViewTarget(tx, subject, { targetType: task.targetType, leadId: null, customerId: null, jobId: null, recoveryCaseId: null, ...targetColumns(task.targetType, task.targetId) });
  if (!mayView || !mayViewTarget) {
    throw new ValidationError({ message: "This employee would not be able to see the task or what it is about.", field: "assigneeId" });
  }
  return { employeeId: employee.id, userId: employee.userId };
}
