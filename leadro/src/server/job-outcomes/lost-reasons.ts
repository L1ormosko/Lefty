import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { baseFieldMap, enforceInTx, projectFields } from "@/server/authz";
import { NotFoundError, ValidationError, conflictOnUniqueViolation, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import type { CreateLostReasonInput, ListLostReasonsQuery, UpdateLostReasonInput } from "./schemas";

/**
 * Lost reasons (§9.2): the tenant's own list of why a visit did not convert. Reading needs
 * `job_outcomes.view` (technicians choose from the list); changing it needs a tenant-wide
 * `job_outcomes.configure` (which makes the role require MFA). A reason is retired with `active: false`,
 * never deleted: outcomes, recovery cases and rules keep pointing at it.
 */

const LOST_REASON_COLUMNS = {
  id: true,
  code: true,
  name: true,
  description: true,
  appliesTo: true,
  recoverable: true,
  active: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LostReasonSelect;

const LOST_REASON_FIELD_MAP = baseFieldMap(Object.keys(LOST_REASON_COLUMNS));

const fullAccess = { allowed: true, fieldSets: ["base"] };
const view = (row: Record<string, unknown>): Record<string, unknown> => projectFields(row, fullAccess, LOST_REASON_FIELD_MAP);

/** The tenant's lost reasons in display order (`sortOrder`, then name). Inactive ones only on request. */
export async function listLostReasons(actor: Actor, query: ListLostReasonsQuery): Promise<Record<string, unknown>[]> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "job_outcomes.view");
    const rows = await tx.lostReason.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(query.includeInactive ? {} : { active: true }),
        ...(query.outcome ? { appliesTo: { has: query.outcome } } : {}),
      },
      select: LOST_REASON_COLUMNS,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
    });
    return rows.map(view);
  });
}

export async function getLostReason(actor: Actor, lostReasonId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "job_outcomes.view");
    const row = await tx.lostReason.findFirst({ where: { id: lostReasonId, tenantId: actor.tenantId }, select: LOST_REASON_COLUMNS });
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

/** Adds a lost reason. The `code` is unique per tenant (409 otherwise) and fixed from now on. */
export async function createLostReason(actor: Actor, ctx: RequestContext, input: CreateLostReasonInput): Promise<Record<string, unknown>> {
  return conflictOnUniqueViolation("A lost reason with this code already exists.", () =>
    withTenant(actor.tenantId, async (tx) => {
      await enforceInTx(tx, actor, "job_outcomes.configure", {});
      const row = await tx.lostReason.create({
        data: {
          tenantId: actor.tenantId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          appliesTo: input.appliesTo,
          recoverable: input.recoverable,
          sortOrder: input.sortOrder,
        },
        select: LOST_REASON_COLUMNS,
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "lost_reason.create",
        targetType: "LostReason",
        targetId: row.id,
        newValue: { code: row.code, appliesTo: row.appliesTo, recoverable: row.recoverable },
      });
      return view(row);
    }),
  );
}

/** Edits a lost reason (name, description, which outcomes it applies to, recoverable, active, order). */
export async function updateLostReason(actor: Actor, ctx: RequestContext, lostReasonId: string, input: UpdateLostReasonInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "job_outcomes.configure", {});
    const previous = await tx.lostReason.findFirst({ where: { id: lostReasonId, tenantId: actor.tenantId }, select: LOST_REASON_COLUMNS });
    if (!previous) throw new NotFoundError();
    if (input.appliesTo && input.appliesTo.length === 0) throw new ValidationError({ field: "appliesTo", message: "A lost reason must apply to at least one outcome." });

    const row = await tx.lostReason.update({
      where: { id: lostReasonId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.appliesTo !== undefined ? { appliesTo: input.appliesTo } : {}),
        ...(input.recoverable !== undefined ? { recoverable: input.recoverable } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
      select: LOST_REASON_COLUMNS,
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "lost_reason.update",
      targetType: "LostReason",
      targetId: row.id,
      previousValue: { active: previous.active, recoverable: previous.recoverable, appliesTo: previous.appliesTo },
      newValue: { active: row.active, recoverable: row.recoverable, appliesTo: row.appliesTo, changedFields: Object.keys(input).sort() },
    });
    return view(row);
  });
}
