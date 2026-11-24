import type { FollowUpTargetType, Prisma } from "@prisma/client";
import type { ResourceRef } from "@/server/authz";
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
 * Recovery cases: the recovery module owns the access rules and registers them with
 * `registerFollowUpTargetAccess("RECOVERY_CASE", ...)` when it loads. Until it has, this default FAILS CLOSED: the case does
 * not exist for the follow-ups module and no list ever includes one, so a missing registration can only hide follow-ups
 * about cases, never show one to someone who may not open the case.
 */
const failClosedRecoveryCaseTarget: FollowUpTargetAccess = {
  viewPermission: "recovery.view",
  facts: async () => null,
  resourceRef: async () => null,
  listWhere: async () => ({ targetType: "RECOVERY_CASE", id: { in: [] } }),
};

/**
 * The registry lives on `globalThis` (same pattern as the notification target registry and the Prisma client): Next.js
 * bundles instrumentation and route handlers separately, so a module-level object would be registered in one bundle and
 * empty in the other.
 */
const globalForTargets = globalThis as unknown as { leadroFollowUpTargets?: Record<FollowUpTargetType, FollowUpTargetAccess> };
const targets: Record<FollowUpTargetType, FollowUpTargetAccess> = (globalForTargets.leadroFollowUpTargets ??= {
  LEAD: leadTarget,
  CUSTOMER: customerTarget,
  JOB: jobTarget,
  RECOVERY_CASE: failClosedRecoveryCaseTarget,
});

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
