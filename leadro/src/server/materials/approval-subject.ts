import { registerApprovalSubject, type ApprovalOutcomeEvent } from "@/server/approvals";
import type { TenantTx } from "@/server/db";
import { lockMaterial } from "./access";
import { MATERIAL_COST_SUBJECT, applyApprovedCostInTx, endPendingVersionInTx } from "./cost-versions";
import { costVersionRowSelect } from "./fields";

/**
 * The materials module's side of the approval engine (subject type MATERIAL_COST_CHANGE; subject id = cost version id).
 * - Scope: materials are tenant-level, so a cost-change request is tenant-level (`{}`): only approvers holding the policy's
 *   permission (default `materials.approve`) at TENANT scope can decide it.
 * - Approved: the version becomes the cost (see `applyApprovedCostInTx`), in the deciding transaction.
 * - Rejected / expired: the version is REJECTED. Cancelled through the approvals API: CANCELLED.
 */
async function onRejected(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const version = await tx.materialCostVersion.findFirst({ where: { id: event.subjectId, tenantId: event.tenantId }, select: costVersionRowSelect });
  if (!version) return;
  await lockMaterial(tx, event.tenantId, version.materialId);
  const locked = await tx.materialCostVersion.findFirstOrThrow({ where: { id: version.id, tenantId: event.tenantId }, select: costVersionRowSelect });
  // Already ended by the materials module itself (withdraw / archive): nothing to do.
  if (locked.status !== "PENDING_APPROVAL") return;
  const status = event.outcome === "CANCELLED" ? "CANCELLED" : "REJECTED";
  const by = event.outcome === "CANCELLED" ? "approval_cancelled" : event.outcome === "EXPIRED" ? "approval_expired" : "approval_rejected";
  await endPendingVersionInTx(tx, event.tenantId, event.ctx, locked, status, event.reason, by);
}

/** Registers MATERIAL_COST_CHANGE with the approval engine. Idempotent; called at module load and from notification-targets. */
export function registerMaterialCostApprovalSubject(): void {
  registerApprovalSubject(MATERIAL_COST_SUBJECT, {
    async resolveResource(tx, tenantId, subjectId) {
      const version = await tx.materialCostVersion.findFirst({ where: { id: subjectId, tenantId }, select: { id: true } });
      return version ? {} : null;
    },
    onApproved: (tx, event) => applyApprovedCostInTx(tx, event.ctx, event.tenantId, event.subjectId, event.approverIds, event.now),
    onRejected,
  });
}
