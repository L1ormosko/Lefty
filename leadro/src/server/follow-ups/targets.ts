import type { FollowUpTargetType, Prisma } from "@prisma/client";
import { buildScopeWhere, resolveScope, type ResourceRef } from "@/server/authz";
import type { Actor } from "@/server/core";
import { resolveCustomerListAccess, customerResourceRef } from "@/server/customers";
import type { TenantTx } from "@/server/db";
import { jobResourceRef, resolveJobListAccess } from "@/server/jobs";
import { leadResourceRef, resolveLeadListAccess } from "@/server/leads";

/**
 * How a follow-up reaches its target. Access to a follow-up requires access to the record it is about (a lead,
 * customer, job or recovery case) in addition to the `follow_ups.*` permission, so a follow-up never becomes a way to
 * learn that a record exists or to read what the viewer could not otherwise reach. Each target type answers three
 * questions, always through the owning module's own access rules:
 *
 *  - `facts`: does it exist, which service-area unit does it belong to, is it archived (what a new task copies);
 *  - `resourceRef`: the scope attributes for a per-record check (`canInTx(viewPermission, ref)`);
 *  - `listWhere`: the caller's coverage of the target as a where-fragment on `FollowUpTask`, for list queries.
 */
export interface FollowUpTargetFacts {
  orgUnitId: string | null;
  archived: boolean;
}

export interface FollowUpTargetAccess {
  /** The permission a viewer needs on the target record. */
  viewPermission: string;
  facts(tx: TenantTx, tenantId: string, targetId: string): Promise<FollowUpTargetFacts | null>;
  resourceRef(tx: TenantTx, tenantId: string, targetId: string): Promise<ResourceRef | null>;
  listWhere(tx: TenantTx, actor: Actor, now: Date): Promise<Prisma.FollowUpTaskWhereInput>;
}

const leadTarget: FollowUpTargetAccess = {
  viewPermission: "leads.view",
  async facts(tx, tenantId, targetId) {
    const row = await tx.lead.findFirst({ where: { id: targetId, tenantId }, select: { orgUnitId: true, archivedAt: true } });
    return row ? { orgUnitId: row.orgUnitId, archived: row.archivedAt !== null } : null;
  },
  resourceRef: (tx, tenantId, targetId) => leadResourceRef(tx, tenantId, targetId),
  async listWhere(tx, actor, now) {
    const access = await resolveLeadListAccess(tx, actor, "leads.view", now);
    return { targetType: "LEAD", lead: { is: access.where } };
  },
};

const customerTarget: FollowUpTargetAccess = {
  viewPermission: "customers.view",
  async facts(tx, tenantId, targetId) {
    const row = await tx.customer.findFirst({ where: { id: targetId, tenantId }, select: { orgUnitId: true, archivedAt: true } });
    return row ? { orgUnitId: row.orgUnitId, archived: row.archivedAt !== null } : null;
  },
  resourceRef: (tx, tenantId, targetId) => customerResourceRef(tx, tenantId, targetId),
  async listWhere(tx, actor, now) {
    const access = await resolveCustomerListAccess(tx, actor, "customers.view", now);
    return { targetType: "CUSTOMER", customer: { is: access.where } };
  },
};

const jobTarget: FollowUpTargetAccess = {
  viewPermission: "jobs.view",
  async facts(tx, tenantId, targetId) {
    const row = await tx.job.findFirst({ where: { id: targetId, tenantId }, select: { orgUnitId: true, archivedAt: true } });
    return row ? { orgUnitId: row.orgUnitId, archived: row.archivedAt !== null } : null;
  },
  resourceRef: (tx, tenantId, targetId) => jobResourceRef(tx, tenantId, targetId),
  async listWhere(tx, actor, now) {
    const access = await resolveJobListAccess(tx, actor, "jobs.view", now);
    return { targetType: "JOB", job: { is: access.where } };
  },
};

/**
 * Recovery cases: the recovery module (Phase 3 Task 6) owns the access rules and should register them with
 * `registerFollowUpTargetAccess("RECOVERY_CASE", ...)`. Until it does, this default applies the same shape every other
 * module uses: `recovery.view` over the case's service-area unit, ASSIGNED / OWN = the case's `assignedToId`.
 */
const defaultRecoveryCaseTarget: FollowUpTargetAccess = {
  viewPermission: "recovery.view",
  async facts(tx, tenantId, targetId) {
    const row = await tx.leadRecoveryCase.findFirst({ where: { id: targetId, tenantId }, select: { orgUnitId: true } });
    return row ? { orgUnitId: row.orgUnitId, archived: false } : null;
  },
  async resourceRef(tx, tenantId, targetId) {
    const row = await tx.leadRecoveryCase.findFirst({ where: { id: targetId, tenantId }, select: { orgUnitId: true, assignedToId: true } });
    if (!row) return null;
    return {
      ...(row.orgUnitId ? { orgUnitId: row.orgUnitId } : {}),
      assignedEmployeeIds: row.assignedToId ? [row.assignedToId] : [],
      ownerEmployeeId: row.assignedToId ?? undefined,
    };
  },
  async listWhere(tx, actor, now) {
    const scope = await resolveScope(tx, actor, "recovery.view", now);
    const where = buildScopeWhere<Prisma.LeadRecoveryCaseWhereInput>(
      scope,
      {
        orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
        legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
        own: (employeeId) => ({ assignedToId: employeeId }),
        assigned: (employeeId) => ({ assignedToId: employeeId }),
      },
      now,
    );
    return { targetType: "RECOVERY_CASE", recoveryCase: { is: where } };
  },
};

const targets: Record<FollowUpTargetType, FollowUpTargetAccess> = {
  LEAD: leadTarget,
  CUSTOMER: customerTarget,
  JOB: jobTarget,
  RECOVERY_CASE: defaultRecoveryCaseTarget,
};

/** The access rules of one target type. */
export const targetAccessFor = (type: FollowUpTargetType): FollowUpTargetAccess => targets[type];

/** Replaces a target type's access rules (the recovery module registers its own at load). Idempotent. */
export function registerFollowUpTargetAccess(type: FollowUpTargetType, access: FollowUpTargetAccess): void {
  targets[type] = access;
}

/** The column that holds the target id for each type: `{ leadId: id }`, `{ jobId: id }`... */
export function targetColumns(type: FollowUpTargetType, targetId: string): Pick<Prisma.FollowUpTaskUncheckedCreateInput, "leadId" | "customerId" | "jobId" | "recoveryCaseId"> {
  switch (type) {
    case "LEAD":
      return { leadId: targetId };
    case "CUSTOMER":
      return { customerId: targetId };
    case "JOB":
      return { jobId: targetId };
    case "RECOVERY_CASE":
      return { recoveryCaseId: targetId };
  }
}

/** The caller's coverage of EVERY target type as one fragment: a task is visible only when its target is. */
export async function visibleTargetsWhere(tx: TenantTx, actor: Actor, now: Date): Promise<Prisma.FollowUpTaskWhereInput> {
  const branches: Prisma.FollowUpTaskWhereInput[] = [];
  for (const type of Object.keys(targets) as FollowUpTargetType[]) branches.push(await targets[type].listWhere(tx, actor, now));
  return { OR: branches };
}
