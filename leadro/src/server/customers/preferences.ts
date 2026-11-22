import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { customerResourceRef } from "./customer-access";
import type { SetEmployeePreferencesInput } from "./schemas";

/**
 * Preferred / avoided technicians of a customer (§7.4 "customer preference", a soft dispatch factor).
 * A preference is information for the dispatcher, never an eligibility rule. Reading needs
 * `customers.view`; replacing the list needs `customers.edit` with the `base` field set.
 */

const preferenceSelect = { employeeId: true, kind: true, note: true, createdAt: true } as const;

export async function listEmployeePreferences(actor: Actor, customerId: string) {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.view");
    const ref = await customerResourceRef(tx, actor.tenantId, customerId);
    if (!ref) throw new NotFoundError();
    await enforceInTx(tx, actor, "customers.view", ref);
    return tx.customerPreferredEmployee.findMany({
      where: { tenantId: actor.tenantId, customerId },
      select: preferenceSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });
}

/**
 * Replaces the customer's whole preference list with the request (an employee listed once, as
 * PREFERRED or AVOID). New entries must be existing, non-terminated employees of the tenant.
 */
export async function setEmployeePreferences(
  actor: Actor,
  ctx: RequestContext,
  customerId: string,
  input: SetEmployeePreferencesInput,
) {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.edit");
    const ref = await customerResourceRef(tx, actor.tenantId, customerId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "customers.edit", ref);
    if (!decision.fieldSets.includes("base")) throw new ForbiddenError();

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-preferences:${customerId}`}))`;
    const existing = await tx.customerPreferredEmployee.findMany({
      where: { tenantId: actor.tenantId, customerId },
      select: { id: true, employeeId: true, kind: true, note: true },
    });
    const existingByEmployee = new Map(existing.map((row) => [row.employeeId, row]));

    const newEmployeeIds = input.preferences.map((entry) => entry.employeeId).filter((id) => !existingByEmployee.has(id));
    if (newEmployeeIds.length > 0) {
      const usable = await tx.employee.count({ where: { tenantId: actor.tenantId, id: { in: newEmployeeIds }, status: { not: "TERMINATED" } } });
      if (usable !== newEmployeeIds.length) {
        throw new ValidationError({ message: "Every employee must exist and not be terminated.", field: "preferences" });
      }
    }

    const keep = new Set(input.preferences.map((entry) => entry.employeeId));
    await tx.customerPreferredEmployee.deleteMany({
      where: { tenantId: actor.tenantId, customerId, employeeId: { notIn: [...keep] } },
    });
    for (const entry of input.preferences) {
      const row = existingByEmployee.get(entry.employeeId);
      if (!row) {
        await tx.customerPreferredEmployee.create({
          data: { tenantId: actor.tenantId, customerId, employeeId: entry.employeeId, kind: entry.kind, note: entry.note ?? null },
        });
      } else if (row.kind !== entry.kind || row.note !== (entry.note ?? null)) {
        await tx.customerPreferredEmployee.update({ where: { id: row.id }, data: { kind: entry.kind, note: entry.note ?? null } });
      }
    }

    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer.preferences_set",
      targetType: "Customer",
      targetId: customerId,
      previousValue: existing.map(({ employeeId, kind }) => ({ employeeId, kind })),
      newValue: input.preferences.map(({ employeeId, kind }) => ({ employeeId, kind })),
    });
    return tx.customerPreferredEmployee.findMany({
      where: { tenantId: actor.tenantId, customerId },
      select: preferenceSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });
}
