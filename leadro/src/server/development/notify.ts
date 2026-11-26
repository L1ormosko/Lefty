import type { DevelopmentPlan } from "@prisma/client";
import type { TenantTx } from "@/server/db";
import { notifyInTx } from "@/server/notifications";

/**
 * The employee hears that a plan about them became active, WITHOUT a link and without params: they hold no
 * `development_plans.view` (they read their non-DRAFT plans through self-service, spec 5.11) and the title is free text.
 * Idempotent per plan (a plan is activated once).
 */
export async function notifyPlanActivated(tx: TenantTx, plan: DevelopmentPlan): Promise<string[]> {
  const employee = await tx.employee.findFirst({ where: { id: plan.employeeId, tenantId: plan.tenantId }, select: { userId: true } });
  if (!employee?.userId) return [];
  const result = await notifyInTx(tx, {
    tenantId: plan.tenantId,
    eventType: "development_plan.activated",
    eventId: `${plan.id}:activated`,
    recipientUserIds: [employee.userId],
  });
  return result.createdNotificationIds;
}
