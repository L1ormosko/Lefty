import { canInTx } from "@/server/authz";
import type { Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * Which of these employees' PRIVATE qualification fields (credential numbers, availability notes) the
 * actor may see in full: their own, and those of employees they may approve qualifications for (HR,
 * Owner). Everyone else gets the masked view. One `can` check per distinct employee, so call it once per
 * page, not per row.
 */
export async function employeesWithVisiblePrivateFields(tx: TenantTx, actor: Actor, employeeIds: string[]): Promise<Set<string>> {
  const visible = new Set<string>();
  for (const employeeId of new Set(employeeIds)) {
    if (actor.employeeId === employeeId || (await canInTx(tx, actor, "qualifications.approve", { employeeId })).allowed) visible.add(employeeId);
  }
  return visible;
}
