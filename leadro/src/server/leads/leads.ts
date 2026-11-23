import type { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { normalizeAddressKey } from "@/lib/address-key";
import { isClosedStatus, isOwnedStatus, requestableLeadStatuses } from "@/lib/lead-lifecycle";
import { normalizePhoneE164, phoneSearchDigits } from "@/lib/phone";
import { auditContextFields, recordAudit } from "@/server/audit";
import {
  LEAD_FIELD_MAP,
  LEAD_WRITE_ALLOWLISTS,
  assertWritableFields,
  enforceInTx,
  projectFields,
  withinScope,
} from "@/server/authz";
import {
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { flagLeadDuplicates, revealableLeadDuplicates } from "./duplicates";
import { LEAD_API_FIELD_MAP, leadRowSelect, leadView } from "./fields";
import { leadResourceRef, leadRowAttributes, resolveLeadListAccess } from "./lead-access";
import { leadViewAfterWrite, loadLeadRow } from "./lead-view";
import { assertLeadServiceAreaUsable } from "./service-area";
import { loadDisabledLeadTransitions, isLeadStatus } from "./status-change";
import type { ArchiveLeadInput, ListLeadsQuery, UpdateLeadInput } from "./schemas";

/**
 * Reading and editing leads (§6.2). Reads need `leads.view` over the lead's scope; an edit needs `leads.edit`
 * over the lead AND every changed field inside what the grant lets the holder write (`assertWritableFields`: a
 * Technician's `{fields:"status"}` grant allows the lifecycle status only, never contact data, notes or money).
 * The status, the owner, the source and the customer link are NOT editable here: they have their own actions.
 */

const definedKeys = (value: object): string[] =>
  Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key]) => key);

const DUPLICATE_KEY_FIELDS = ["contactPhone", "contactEmail", "contactName", "addressLine1", "addressLine2", "addressCity", "addressRegion", "addressPostalCode"];

/** One lead with its owner and the statuses it can be moved to next (`nextStatuses`); outside the caller's scope it is a 404. */
export async function getLead(actor: Actor, leadId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.view");
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "leads.view", ref);
    const row = await loadLeadRow(tx, actor.tenantId, leadId);
    if (!row) throw new NotFoundError();
    const disabled = await loadDisabledLeadTransitions(tx, actor.tenantId);
    const owner = ref.assignedEmployeeIds?.[0] ?? null;
    const nextStatuses = isLeadStatus(row.status) && !row.archivedAt ? requestableLeadStatuses(row.status, disabled) : [];
    return projectFields({ ...leadView(row, owner), nextStatuses }, decision, LEAD_API_FIELD_MAP);
  });
}

/** The where-fragment of the `q` search: contact name, email, partial phone digits, or lead number (`#1234`). */
function searchWhere(term: string): Prisma.LeadWhereInput {
  const conditions: Prisma.LeadWhereInput[] = [
    { contactName: { contains: term, mode: "insensitive" } },
    { contactEmail: { contains: term, mode: "insensitive" } },
  ];
  const digits = phoneSearchDigits(term);
  if (digits) conditions.push({ contactPhoneE164: { contains: digits } });
  const numeric = /^#?(\d{1,9})$/.exec(term);
  if (numeric) conditions.push({ number: Number(numeric[1]) });
  return { OR: conditions };
}

/**
 * One page of leads the caller may see, newest first (then id). The data scope (including record-set grants) is
 * part of the query; each row is projected with the field sets of the grants that cover THAT row.
 */
export async function listLeads(actor: Actor, query: ListLeadsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.view");
    const now = new Date();
    const access = await resolveLeadListAccess(tx, actor, "leads.view", now);

    // "me" with no employee record matches nothing (a user without an employee owns no lead).
    const assigneeId = query.assigneeEmployeeId === "me" ? (actor.employeeId ?? "none") : query.assigneeEmployeeId;
    // Each filter is its own AND member: two filters on the same relation or column (assigned + assignee, status +
    // follow-up queue) must narrow each other, never overwrite one another.
    const filters: Prisma.LeadWhereInput[] = [
      query.archived === "exclude" ? { archivedAt: null } : query.archived === "only" ? { archivedAt: { not: null } } : {},
      ...(query.status ? [{ status: query.status }] : []),
      ...(query.priority ? [{ priority: query.priority }] : []),
      ...(query.sourceId ? [{ sourceId: query.sourceId }] : []),
      ...(query.orgUnitId ? [{ orgUnitId: query.orgUnitId }] : []),
      ...(query.customerId ? [{ customerId: query.customerId }] : []),
      ...(query.assigned === "true" ? [{ assignments: { some: { state: "ACTIVE" as const } } }] : []),
      ...(query.assigned === "false" ? [{ assignments: { none: { state: "ACTIVE" as const } } }] : []),
      ...(assigneeId ? [{ assignments: { some: { state: "ACTIVE" as const, employeeId: assigneeId } } }] : []),
      ...(query.followUpDue ? [{ nextFollowUpAt: { lte: now }, status: { notIn: ["CONVERTED", "LOST", "DUPLICATE", "CANCELLED"] as Array<"CONVERTED" | "LOST" | "DUPLICATE" | "CANCELLED"> } }] : []),
      ...(query.q ? [searchWhere(query.q)] : []),
    ];
    const callerWhere: Prisma.LeadWhereInput = { tenantId: actor.tenantId, AND: filters };
    const rows = await tx.lead.findMany({
      where: withinScope(access.where, callerWhere),
      select: leadRowSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const attributes = await leadRowAttributes(tx, actor.tenantId, page.data);
    const data = page.data.map((row) => {
      const rowAttributes = attributes.get(row.id);
      const fieldSets = rowAttributes ? access.fieldSetsOf(rowAttributes) : [];
      return projectFields(leadView(row, rowAttributes?.assignedEmployeeIds[0] ?? null), { allowed: true, fieldSets }, LEAD_API_FIELD_MAP);
    });
    return { data, page: page.page };
  });
}

/**
 * Edits a lead (partial). Moving the service area needs the permission over the destination unit too (moving to
 * "no unit" needs a tenant-wide grant). Closed and archived leads are read-only: reopen / restore first.
 */
export async function updateLead(
  actor: Actor,
  ctx: RequestContext,
  leadId: string,
  input: UpdateLeadInput,
): Promise<Record<string, unknown>> {
  const { possibleDuplicates, view } = await withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.edit");
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "leads.edit", ref);

    // Derived columns change with their source columns; they are part of what the grant must allow.
    const patch: Record<string, unknown> = { ...input };
    if (input.contactPhone !== undefined) patch.contactPhoneE164 = input.contactPhone ? normalizePhoneE164(input.contactPhone) : null;
    assertWritableFields(decision, definedKeys(patch), LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS);

    const current = await loadLeadRow(tx, actor.tenantId, leadId);
    if (!current) throw new NotFoundError();
    if (current.archivedAt) throw new InvalidStateTransitionError({ message: "An archived lead cannot be edited. Restore it first." });
    if (isClosedStatus(current.status)) {
      throw new InvalidStateTransitionError({ message: `A ${current.status} lead cannot be edited. Reopen it first.` });
    }

    const addressTouched = ["addressLine1", "addressLine2", "addressCity", "addressRegion", "addressPostalCode"].some((key) => key in patch && patch[key] !== undefined);
    if (addressTouched) {
      const merged = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) } as typeof current;
      patch.addressNormalizedKey =
        merged.addressLine1 && merged.addressCity && merged.addressRegion && merged.addressPostalCode
          ? normalizeAddressKey({
              line1: merged.addressLine1,
              line2: merged.addressLine2,
              city: merged.addressCity,
              region: merged.addressRegion,
              postalCode: merged.addressPostalCode,
              countryCode: "US",
            })
          : null;
    }
    const { changedKeys, previous, next } = changedFields(current, patch);
    if (changedKeys.length === 0) return { possibleDuplicates: [], view: await leadViewAfterWrite(tx, actor, leadId) };

    if (changedKeys.includes("orgUnitId")) {
      if (input.orgUnitId) await assertLeadServiceAreaUsable(tx, actor, "leads.edit", input.orgUnitId, ref);
      else await enforceInTx(tx, actor, "leads.edit", {});
    }
    if (input.jobTypeId) {
      const jobType = await tx.jobType.findFirst({ where: { id: input.jobTypeId, tenantId: actor.tenantId }, select: { id: true } });
      if (!jobType) throw new ValidationError({ message: "Unknown job type.", field: "jobTypeId" });
    }

    await tx.lead.update({
      where: { id: leadId },
      data: {
        ...input,
        contactPhoneE164: patch.contactPhoneE164 as string | null | undefined,
        addressNormalizedKey: patch.addressNormalizedKey as string | null | undefined,
      },
    });
    await recordAudit(tx, { ...auditContextFields(ctx), action: "lead.update", targetType: "Lead", targetId: leadId, previousValue: previous, newValue: next });

    const rematch = changedKeys.some((key) => DUPLICATE_KEY_FIELDS.includes(key));
    const open = rematch ? await revealableLeadDuplicates(tx, actor, await flagLeadDuplicates(tx, ctx, leadId)) : [];
    return { possibleDuplicates: open, view: await leadViewAfterWrite(tx, actor, leadId) };
  });
  return { ...view, possibleDuplicates };
}

/** Archives a lead (soft remove; history stays). Ends the owner's assignment so ASSIGNED access stops. Needs `leads.archive`. */
export async function archiveLead(actor: Actor, ctx: RequestContext, leadId: string, input: ArchiveLeadInput): Promise<Record<string, unknown>> {
  return setArchived(actor, ctx, leadId, true, input.reason);
}

/** Brings an archived lead back (its assignment stays ended: assign it again). Needs `leads.archive`. */
export async function restoreLead(actor: Actor, ctx: RequestContext, leadId: string, input: ArchiveLeadInput): Promise<Record<string, unknown>> {
  return setArchived(actor, ctx, leadId, false, input.reason);
}

/**
 * A lead archived in an owned status lost its assignment; restoring it must not leave "ASSIGNED without an owner"
 * (invariant: ASSIGNED..DISPATCHED means somebody owns it). It goes back to UNASSIGNED, with a history row. Written
 * directly (not through the machine) because restoring must always restore a consistent state, whatever a tenant disabled.
 */
async function releaseOwnerlessLead(tx: TenantTx, actor: Actor, leadId: string): Promise<void> {
  const lead = await tx.lead.findFirst({ where: { id: leadId, tenantId: actor.tenantId }, select: { status: true } });
  if (!lead || !isLeadStatus(lead.status) || !isOwnedStatus(lead.status)) return;
  const owner = await tx.leadAssignment.findFirst({ where: { tenantId: actor.tenantId, leadId, state: "ACTIVE" }, select: { id: true } });
  if (owner) return;
  await tx.lead.update({ where: { id: leadId }, data: { status: "UNASSIGNED", statusChangedAt: new Date() } });
  await tx.leadStatusHistory.create({
    data: { tenantId: actor.tenantId, leadId, fromStatus: lead.status, toStatus: "UNASSIGNED", actorType: "USER", actorUserId: actor.userId, reason: "restored without an owner" },
  });
}

async function setArchived(
  actor: Actor,
  ctx: RequestContext,
  leadId: string,
  archive: boolean,
  reason: string | undefined,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.archive");
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    await enforceInTx(tx, actor, "leads.archive", ref);

    const current = await tx.lead.findFirst({ where: { id: leadId, tenantId: actor.tenantId }, select: { archivedAt: true } });
    if (!current) throw new NotFoundError();
    if (archive && current.archivedAt) throw new InvalidStateTransitionError({ message: "The lead is already archived." });
    if (!archive && !current.archivedAt) throw new InvalidStateTransitionError({ message: "The lead is not archived." });

    const archivedAt = archive ? new Date() : null;
    await tx.lead.update({ where: { id: leadId }, data: { archivedAt } });
    if (!archive) await releaseOwnerlessLead(tx, actor, leadId);
    if (archive) {
      await tx.leadAssignment.updateMany({
        where: { tenantId: actor.tenantId, leadId, state: "ACTIVE" },
        data: { state: "ENDED", endedAt: archivedAt, endedReason: "lead archived" },
      });
    }
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: archive ? "lead.archive" : "lead.restore",
      targetType: "Lead",
      targetId: leadId,
      previousValue: { archivedAt: current.archivedAt },
      newValue: { archivedAt },
      reason,
    });
    return leadViewAfterWrite(tx, actor, leadId);
  });
}
