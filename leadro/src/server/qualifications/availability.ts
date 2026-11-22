import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, narrowScopeToFieldSet, resolveScope, withinScope } from "@/server/authz";
import {
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant } from "@/server/db";
import type { CreateAvailabilityInput, ListByEmployeeQuery } from "./schemas";
import { resolveEmployeeTimeZone } from "./time-zones";
import { assertBaseFields, availabilityScopeColumns, toAvailabilityView } from "./views";

/**
 * Availability (§10.1, §16.5): recurring weekly windows plus dated exceptions (time off, extra
 * shifts), each read in an IANA time zone (default: the employee's own, else their branch's, else the
 * company's). Windows cannot cross midnight: a night shift is two windows. The eligibility rules
 * (`src/lib/eligibility`) evaluate them per local date, DST included.
 *
 * Needs `qualifications.edit` over the employee. Unlike credentials these rows are plain schedule
 * data, so a window or exception is DELETED when it is wrong or no longer applies (the audit event
 * keeps what it said); there is no verification step.
 */

type AvailabilityView = ReturnType<typeof toAvailabilityView>;

export async function createAvailability(actor: Actor, ctx: RequestContext, input: CreateAvailabilityInput): Promise<AvailabilityView> {
  return withTenant(actor.tenantId, async (tx) => {
    const decision = await enforceInTx(tx, actor, "qualifications.edit", { employeeId: input.employeeId });
    assertBaseFields(decision);
    const employee = await tx.employee.findFirst({ where: { id: input.employeeId, tenantId: actor.tenantId }, select: { status: true } });
    if (!employee) throw new NotFoundError();
    if (employee.status === "TERMINATED") throw new InvalidStateTransitionError({ message: "A terminated employee's availability cannot be changed." });

    const timeZone = input.timeZone ?? (await resolveEmployeeTimeZone(tx, actor.tenantId, input.employeeId));
    const data: Prisma.AvailabilityUncheckedCreateInput =
      input.kind === "WEEKLY_WINDOW"
        ? {
            tenantId: actor.tenantId,
            employeeId: input.employeeId,
            kind: input.kind,
            timeZone,
            isoDayOfWeek: input.isoDayOfWeek,
            startMinute: input.startMinute,
            endMinute: input.endMinute,
            validFrom: input.validFrom,
            validTo: input.validTo,
            note: input.note,
          }
        : {
            tenantId: actor.tenantId,
            employeeId: input.employeeId,
            kind: input.kind,
            timeZone,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            note: input.note,
          };
    const row = await tx.availability.create({ data });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "availability.create",
      targetType: "Availability",
      targetId: row.id,
      newValue: { ...toAvailabilityView(row) },
    });
    return toAvailabilityView(row);
  });
}

export async function deleteAvailability(actor: Actor, ctx: RequestContext, availabilityId: string): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.edit");
    const row = await tx.availability.findFirst({ where: { id: availabilityId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "qualifications.edit", { employeeId: row.employeeId });
    assertBaseFields(decision);
    await tx.availability.delete({ where: { id: row.id } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "availability.delete",
      targetType: "Availability",
      targetId: row.id,
      previousValue: toAvailabilityView(row),
    });
  });
}

/** One employee's availability rows (`qualifications.view` over them): weekly windows by day and time, then exceptions by start. */
export async function listAvailability(actor: Actor, query: ListByEmployeeQuery): Promise<Page<AvailabilityView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "qualifications.view");
    const now = new Date();
    const scope = narrowScopeToFieldSet(await resolveScope(tx, actor, "qualifications.view", now), "base");
    const callerWhere: Prisma.AvailabilityWhereInput = {
      tenantId: actor.tenantId,
      employeeId: query.employeeId,
      // "Active" for availability = still relevant: weekly windows not past their validTo, exceptions not over.
      ...(query.activeOnly
        ? {
            OR: [
              { kind: "WEEKLY_WINDOW", OR: [{ validTo: null }, { validTo: { gte: new Date(now.toISOString().slice(0, 10)) } }] },
              { kind: { in: ["EXCEPTION_AVAILABLE", "EXCEPTION_UNAVAILABLE"] }, endsAt: { gt: now } },
            ],
          }
        : {}),
    };
    const rows = await tx.availability.findMany({
      where: withinScope(buildScopeWhere(scope, availabilityScopeColumns, now), callerWhere),
      orderBy: [{ kind: "asc" }, { isoDayOfWeek: "asc" }, { startMinute: "asc" }, { startsAt: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toAvailabilityView), page: page.page };
  });
}
