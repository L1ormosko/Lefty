import type { Prisma } from "@prisma/client";
import { buildScopeWhere, resolveScope } from "@/server/authz";
import { registerFollowUpTargetAccess } from "@/server/follow-ups";
import { caseResourceRef, caseScopeColumns } from "./access";

/**
 * Teaches the follow-ups module how to reach a recovery case (a follow-up about a case requires `recovery.view` over the
 * case). Registered when the module loads; idempotent. Uses the recovery module's own scope rules, so a follow-up never
 * reveals a case its reader could not open.
 */
export function registerRecoveryFollowUpTarget(): void {
  registerFollowUpTargetAccess("RECOVERY_CASE", {
    viewPermission: "recovery.view",
    async facts(tx, tenantId, targetId) {
      const row = await tx.leadRecoveryCase.findFirst({ where: { id: targetId, tenantId }, select: { orgUnitId: true } });
      return row ? { orgUnitId: row.orgUnitId, archived: false } : null;
    },
    async resourceRef(tx, tenantId, targetId) {
      const row = await tx.leadRecoveryCase.findFirst({ where: { id: targetId, tenantId }, select: { orgUnitId: true, assignedToId: true } });
      return row ? caseResourceRef(row) : null;
    },
    async listWhere(tx, actor, now) {
      const scope = await resolveScope(tx, actor, "recovery.view", now);
      const where: Prisma.LeadRecoveryCaseWhereInput = buildScopeWhere(scope, caseScopeColumns, now);
      return { targetType: "RECOVERY_CASE", recoveryCase: { is: where } };
    },
  });
}
