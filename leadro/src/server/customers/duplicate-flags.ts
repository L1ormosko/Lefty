import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant } from "@/server/db";
import { customerResourceRef, resolveCustomerListAccess } from "./customer-access";
import type { ListDuplicatesQuery, ResolveDuplicateInput } from "./schemas";

/**
 * Customer duplicate flags: the review queue and manual resolution (§6.4). Nothing here merges
 * records: "confirmed duplicate" only records the human decision (the pair stays two customers).
 *
 * Isolation rule: a flag is visible only to a caller who may view BOTH customers of the pair, and
 * resolving needs `customers.edit` over both. Otherwise the existence of a matching customer
 * outside the caller's scope would leak through the queue. Pairs spanning scopes therefore surface
 * to someone with a wider scope (a state manager, a tenant-wide role).
 */

const flagSelect = {
  id: true,
  customerId: true,
  otherCustomerId: true,
  matchedOn: true,
  reason: true,
  status: true,
  detectedAt: true,
  resolvedAt: true,
  resolvedById: true,
  resolutionNote: true,
} satisfies Prisma.DuplicateFlagSelect;

/** Review queue of customer duplicate flags, newest detection first. Needs `customers.view`; scope applies to both customers. */
export async function listDuplicateFlags(actor: Actor, query: ListDuplicatesQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.view");
    const access = await resolveCustomerListAccess(tx, actor, "customers.view");
    const where: Prisma.DuplicateFlagWhereInput = {
      AND: [
        { tenantId: actor.tenantId, kind: "CUSTOMER_CUSTOMER", status: query.status },
        { customer: access.where },
        { otherCustomer: access.where },
        ...(query.customerId ? [{ OR: [{ customerId: query.customerId }, { otherCustomerId: query.customerId }] }] : []),
      ],
    };
    const rows = await tx.duplicateFlag.findMany({
      where,
      select: flagSelect,
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}

/**
 * Records a person's decision on an open or already-decided flag. `NOT_DUPLICATE` keeps the pair from
 * ever being flagged again; `CONFIRMED_DUPLICATE` records that they are the same party. A decision can
 * be changed to the other one later (audited with the previous status); repeating the same one is refused.
 */
export async function resolveDuplicateFlag(
  actor: Actor,
  ctx: RequestContext,
  flagId: string,
  input: ResolveDuplicateInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.edit");
    const flag = await tx.duplicateFlag.findFirst({
      where: { id: flagId, tenantId: actor.tenantId, kind: "CUSTOMER_CUSTOMER" },
      select: flagSelect,
    });
    if (!flag || !flag.customerId || !flag.otherCustomerId) throw new NotFoundError();

    // Both customers must be editable by the caller; an out-of-scope side makes the whole flag a 404.
    for (const customerId of [flag.customerId, flag.otherCustomerId]) {
      const ref = await customerResourceRef(tx, actor.tenantId, customerId);
      if (!ref) throw new NotFoundError();
      await enforceInTx(tx, actor, "customers.edit", ref);
    }

    if (flag.status === input.resolution) {
      throw new InvalidStateTransitionError({ message: "The duplicate flag already has this resolution." });
    }

    const now = new Date();
    // Optimistic guard: a concurrent decision changes the status, and the loser gets a 409.
    const updated = await tx.duplicateFlag.updateMany({
      where: { id: flag.id, tenantId: actor.tenantId, status: flag.status },
      data: { status: input.resolution, resolvedAt: now, resolvedById: actor.userId, resolutionNote: input.note ?? null },
    });
    if (updated.count === 0) throw new ConflictError({ message: "The duplicate flag was changed by someone else." });

    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer.duplicate_resolve",
      targetType: "DuplicateFlag",
      targetId: flag.id,
      previousValue: { status: flag.status },
      newValue: { status: input.resolution, customerId: flag.customerId, otherCustomerId: flag.otherCustomerId },
      reason: input.note,
    });
    return { ...flag, status: input.resolution, resolvedAt: now, resolvedById: actor.userId, resolutionNote: input.note ?? null };
  });
}
