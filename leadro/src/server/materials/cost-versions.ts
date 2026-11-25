import type { MaterialCostStatus } from "@prisma/client";
import { newVersionPlacementProblem } from "@/lib/material-cost-rules";
import { cancelApprovalForSubjectInTx, createApprovalRequestInTx } from "@/server/approvals";
import { recordAudit, type AuditContextFields } from "@/server/audit";
import { ConflictError, InvalidStateTransitionError, NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { enforceCatalogPermission, enforceCostFieldSet, enforceMaterialsView, lockMaterial } from "./access";
import { costVersionRowSelect, costVersionView, type CostVersionRow } from "./fields";
import type { ListCostVersionsQuery, ProposeCostInput, WithdrawCostInput } from "./schemas";

/**
 * Versioned material costs (spec 11.4, 25.4; contract in DECISIONS.md "Contracts for Phase 4 Tasks 2-6").
 *
 * A cost is never edited. A change is a new `MaterialCostVersion` (version number + 1) that starts PENDING_APPROVAL; when
 * the tenant's `MATERIAL_COST_CHANGE` policy requires approval it waits for the approval engine, otherwise it is approved
 * on the spot (`approvalRequestId = null`). Approving a version effective at D first closes the current approved version
 * (`effectiveTo = D`), then marks the new one APPROVED: approved versions never overlap (GiST constraint), and the database
 * freezes cost, currency, start and number (trigger). The version takes effect on its own `effectiveFrom`, not on the
 * approval date. One pending version per material at a time.
 */

export const MATERIAL_COST_SUBJECT = "MATERIAL_COST_CHANGE" as const;

/** Deterministic approval idempotency key per version (prefixed with the subject type, as the engine asks). */
export const costApprovalKey = (versionId: string): string => `${MATERIAL_COST_SUBJECT}:${versionId}`;

/** Audit fields for writes that may run without a person (the approval expiry sweep calls back with no context). */
export function materialAuditFields(tenantId: string, ctx: RequestContext | null): AuditContextFields {
  return { tenantId, actorUserId: ctx?.actor?.userId ?? null, sourceApp: ctx?.actor ? ctx.sourceApp : "SYSTEM", correlationId: ctx?.correlationId };
}

/** The approved version with the latest start (the current one, or the one about to start), or null. */
export function latestApprovedVersion(tx: TenantTx, tenantId: string, materialId: string): Promise<CostVersionRow | null> {
  return tx.materialCostVersion.findFirst({
    where: { tenantId, materialId, status: "APPROVED" },
    orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
    select: costVersionRowSelect,
  });
}

/** The version waiting for approval, or null. */
export function pendingVersion(tx: TenantTx, tenantId: string, materialId: string): Promise<CostVersionRow | null> {
  return tx.materialCostVersion.findFirst({ where: { tenantId, materialId, status: "PENDING_APPROVAL" }, select: costVersionRowSelect });
}

/**
 * Refuses a version starting at `effectiveFrom` that cannot follow the latest approved version (see
 * `newVersionPlacementProblem`). Called when proposing AND again when approving (another version may have been approved,
 * or a usage costed, in between). The caller holds the material lock.
 * @throws ConflictError with detail code `material.cost_not_after_current` or `material.cost_before_costed_usage`.
 */
async function assertPlacement(tx: TenantTx, tenantId: string, materialId: string, effectiveFrom: Date): Promise<CostVersionRow | null> {
  const current = await latestApprovedVersion(tx, tenantId, materialId);
  const latestCosted = current
    ? await tx.jobMaterialUsage.findFirst({ where: { tenantId, costVersionId: current.id }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } })
    : null;
  const problem = newVersionPlacementProblem({ effectiveFrom, current, latestCostedUsageAt: latestCosted?.occurredAt ?? null });
  if (problem === "not_after_current") {
    throw new ConflictError({
      message: "A new cost must start after the start of the current cost version.",
      details: [{ field: "effectiveFrom", code: "material.cost_not_after_current", message: "Choose a later effective date." }],
    });
  }
  if (problem === "costed_usage_after") {
    throw new ConflictError({
      message: "Job materials on or after this date were already costed with the current version; a cost change never rewrites them.",
      details: [{ field: "effectiveFrom", code: "material.cost_before_costed_usage", message: "Choose a later effective date, or correct the past job with an adjustment." }],
    });
  }
  return current;
}

/**
 * Makes a PENDING version the approved cost: closes the current approved version at the new start, then sets APPROVED +
 * `approvedAt` (order matters: the GiST constraint checks each statement). The caller holds the material lock.
 */
async function approveVersionInTx(tx: TenantTx, version: CostVersionRow, tenantId: string, approvedAt: Date): Promise<CostVersionRow> {
  const current = await assertPlacement(tx, tenantId, version.materialId, version.effectiveFrom);
  if (current && current.effectiveTo === null) {
    await tx.materialCostVersion.update({ where: { id: current.id }, data: { effectiveTo: version.effectiveFrom } });
  }
  return tx.materialCostVersion.update({ where: { id: version.id }, data: { status: "APPROVED", approvedAt }, select: costVersionRowSelect });
}

export interface ProposedCost {
  version: Record<string, unknown>;
  /** True when an approval request was opened; false when no policy applied and the version is already APPROVED. */
  approvalRequired: boolean;
  approvalRequestId: string | null;
}

/**
 * `POST /materials/{id}/costs`: proposes a new cost version. Needs `materials.create` at TENANT scope AND the `cost` set
 * (a cost is written only by someone who may see costs). The proposer is the approval requester, so separation of duties
 * keeps them from approving it.
 * @throws ForbiddenError, NotFoundError, InvalidStateTransitionError (archived material), ConflictError (a version is
 *   already pending, or the date does not follow the current version), ValidationError (no policy in this currency).
 */
export async function proposeCostVersion(actor: Actor, ctx: RequestContext, materialId: string, input: ProposeCostInput): Promise<ProposedCost> {
  const result = await withTenant(actor.tenantId, async (tx) => {
    await enforceCatalogPermission(tx, actor, "materials.create");
    await enforceCostFieldSet(tx, actor);
    const material = await lockMaterial(tx, actor.tenantId, materialId);
    if (!material.active) throw new InvalidStateTransitionError({ message: "The material is archived; it takes no new costs." });
    if (await pendingVersion(tx, actor.tenantId, materialId)) {
      throw new ConflictError({ message: "This material already has a cost change waiting for approval. Withdraw it or wait for the decision." });
    }
    const previous = await assertPlacement(tx, actor.tenantId, materialId, input.effectiveFrom);
    const last = await tx.materialCostVersion.findFirst({ where: { tenantId: actor.tenantId, materialId }, orderBy: { versionNumber: "desc" }, select: { versionNumber: true } });

    const created = await tx.materialCostVersion.create({
      data: {
        tenantId: actor.tenantId,
        materialId,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        unitCostMinor: input.unitCostMinor,
        currency: input.currency,
        effectiveFrom: input.effectiveFrom,
        note: input.note ?? null,
        createdById: actor.userId,
      },
      select: costVersionRowSelect,
    });
    await recordAudit(tx, {
      ...materialAuditFields(actor.tenantId, ctx),
      action: "material_cost_version.propose",
      targetType: "MaterialCostVersion",
      targetId: created.id,
      newValue: {
        status: created.status,
        materialId,
        versionNumber: created.versionNumber,
        unitCostMinor: created.unitCostMinor,
        currency: created.currency,
        effectiveFrom: created.effectiveFrom,
        previousVersionId: previous?.id ?? null,
      },
      reason: input.note,
    });

    // Ids, codes and amounts only (the engine refuses free text in details); the note travels as the request's reason.
    const approval = await createApprovalRequestInTx(tx, ctx, {
      tenantId: actor.tenantId,
      subjectType: MATERIAL_COST_SUBJECT,
      subjectId: created.id,
      reason: input.note ?? null,
      details: {
        materialId,
        materialCode: material.code,
        versionNumber: created.versionNumber,
        unitCostMinor: created.unitCostMinor,
        currency: created.currency,
        effectiveFrom: created.effectiveFrom.toISOString(),
        previousVersionId: previous?.id ?? null,
        previousUnitCostMinor: previous?.unitCostMinor ?? null,
        previousCurrency: previous?.currency ?? null,
      },
      idempotencyKey: costApprovalKey(created.id),
    });

    if (!approval.required) {
      // No MATERIAL_COST_CHANGE policy: the change applies directly and records `approvalRequestId = null`.
      const approved = await approveVersionInTx(tx, created, actor.tenantId, new Date());
      await recordAudit(tx, {
        ...materialAuditFields(actor.tenantId, ctx),
        action: "material_cost_version.approved",
        targetType: "MaterialCostVersion",
        targetId: approved.id,
        previousValue: { status: "PENDING_APPROVAL" },
        newValue: { status: "APPROVED", materialId, by: "no_policy" },
      });
      return { version: approved, approvalRequestId: null, notificationIds: [] as string[] };
    }
    const linked = await tx.materialCostVersion.update({ where: { id: created.id }, data: { approvalRequestId: approval.request.id }, select: costVersionRowSelect });
    return { version: linked, approvalRequestId: approval.request.id, notificationIds: approval.notificationIds };
  });
  await deliverAfterCommit(actor.tenantId, result.notificationIds);
  return { version: costVersionView(result.version), approvalRequired: result.approvalRequestId !== null, approvalRequestId: result.approvalRequestId };
}

/**
 * `POST /materials/{id}/costs/{versionId}/withdraw`: withdraws a pending version (CANCELLED) and cancels its approval
 * request (the engine does not call us back: we are the caller). The proposer may always withdraw their own; anyone else
 * needs `materials.create` at TENANT scope. Both need the `cost` set.
 * @throws ForbiddenError, NotFoundError, InvalidStateTransitionError (not pending)
 */
export async function withdrawCostVersion(actor: Actor, ctx: RequestContext, materialId: string, versionId: string, input: WithdrawCostInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceCostFieldSet(tx, actor);
    await lockMaterial(tx, actor.tenantId, materialId);
    const version = await tx.materialCostVersion.findFirst({ where: { id: versionId, materialId, tenantId: actor.tenantId }, select: costVersionRowSelect });
    if (!version) throw new NotFoundError();
    if (version.createdById !== actor.userId) await enforceCatalogPermission(tx, actor, "materials.create");
    if (version.status !== "PENDING_APPROVAL") throw new InvalidStateTransitionError({ message: `This cost version is already ${version.status}.` });
    const updated = await endPendingVersionInTx(tx, actor.tenantId, ctx, version, "CANCELLED", input.reason, "withdrawn");
    await cancelApprovalForSubjectInTx(tx, ctx, { tenantId: actor.tenantId, subjectType: MATERIAL_COST_SUBJECT, subjectId: version.id, reason: input.reason });
    return costVersionView(updated);
  });
}

/** Ends a pending version without approval (REJECTED or CANCELLED) and audits it. Shared by withdraw, archive and the engine callback. */
export async function endPendingVersionInTx(
  tx: TenantTx,
  tenantId: string,
  ctx: RequestContext | null,
  version: CostVersionRow,
  status: Extract<MaterialCostStatus, "REJECTED" | "CANCELLED">,
  reason: string | null,
  by: "withdrawn" | "archived" | "approval_rejected" | "approval_expired" | "approval_cancelled",
): Promise<CostVersionRow> {
  const claim = await tx.materialCostVersion.updateMany({ where: { id: version.id, tenantId, status: "PENDING_APPROVAL" }, data: { status } });
  if (claim.count !== 1) throw new ConflictError({ message: "The cost version changed at the same time. Reload and try again." });
  await recordAudit(tx, {
    ...materialAuditFields(tenantId, ctx),
    action: `material_cost_version.${status.toLowerCase()}`,
    targetType: "MaterialCostVersion",
    targetId: version.id,
    previousValue: { status: "PENDING_APPROVAL" },
    newValue: { status, materialId: version.materialId, by },
    reason: reason ?? undefined,
  });
  return tx.materialCostVersion.findFirstOrThrow({ where: { id: version.id, tenantId }, select: costVersionRowSelect });
}

/**
 * The approval engine's `onApproved`: the version becomes the approved cost (closing the current one). If the date no
 * longer fits (another version was approved, or usage after the date was costed meanwhile) this throws a ConflictError and
 * the decision rolls back with it; the approver then rejects the request instead.
 */
export async function applyApprovedCostInTx(tx: TenantTx, ctx: RequestContext | null, tenantId: string, versionId: string, approverIds: string[], now: Date): Promise<void> {
  const version = await tx.materialCostVersion.findFirst({ where: { id: versionId, tenantId }, select: costVersionRowSelect });
  if (!version) throw new NotFoundError();
  await lockMaterial(tx, tenantId, version.materialId);
  const locked = await tx.materialCostVersion.findFirstOrThrow({ where: { id: versionId, tenantId }, select: costVersionRowSelect });
  if (locked.status !== "PENDING_APPROVAL") throw new ConflictError({ message: `The cost version is already ${locked.status}.` });
  const approved = await approveVersionInTx(tx, locked, tenantId, now);
  await recordAudit(tx, {
    ...materialAuditFields(tenantId, ctx),
    action: "material_cost_version.approved",
    targetType: "MaterialCostVersion",
    targetId: approved.id,
    previousValue: { status: "PENDING_APPROVAL" },
    newValue: { status: "APPROVED", materialId: approved.materialId, approvalRequestId: approved.approvalRequestId, approverIds, by: "approval" },
  });
}

/**
 * `GET /materials/{id}/costs`: every version of a material (history), newest version first. Needs the `cost` set (403).
 * @throws ForbiddenError, NotFoundError
 */
export async function listCostVersions(actor: Actor, materialId: string, query: ListCostVersionsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceMaterialsView(tx, actor);
    await enforceCostFieldSet(tx, actor);
    const material = await tx.material.findFirst({ where: { id: materialId, tenantId: actor.tenantId }, select: { id: true } });
    if (!material) throw new NotFoundError();
    const rows = await tx.materialCostVersion.findMany({
      where: { tenantId: actor.tenantId, materialId, ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ versionNumber: "desc" }, { id: "desc" }],
      select: costVersionRowSelect,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(costVersionView), page: page.page };
  });
}
