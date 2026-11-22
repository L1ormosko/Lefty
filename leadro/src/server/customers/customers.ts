import { Prisma } from "@prisma/client";
import { changedFields } from "@/lib/changed-fields";
import { normalizePhoneE164, phoneSearchDigits } from "@/lib/phone";
import { auditContextFields, recordAudit } from "@/server/audit";
import {
  CUSTOMER_FIELD_MAP,
  assertWritableFields,
  canInTx,
  enforceInTx,
  projectFields,
  withinScope,
  type AccessDecision,
} from "@/server/authz";
import {
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  nextNumber,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { insertAddresses } from "./addresses";
import {
  CUSTOMER_RECORD_SETS,
  customerResourceRef,
  customerRowAttributes,
  resolveCustomerListAccess,
  toResourceRef,
  visibleCustomerIds,
} from "./customer-access";
import { flagCustomerDuplicates, type OpenDuplicate } from "./duplicate-detection";
import {
  ADDRESS_COLUMNS,
  CUSTOMER_API_FIELD_MAP,
  addressView,
  customerRowSelect,
  customerView,
  type CustomerRow,
} from "./fields";
import { assertServiceAreaUsable } from "./service-area";
import type { ArchiveCustomerInput, CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from "./schemas";

/**
 * Customer records (§6.1). Reads need `customers.view` over the customer's scope; writes need the
 * permission over the scope AND the field sets they touch (`assertWritableFields`: billing columns only
 * for a grant that names the billing set). Everything is audited in the same transaction, and
 * duplicate detection (§6.4) runs after every write that can change a match key.
 * Customers are archived, never deleted.
 */

const BILLING_FIELDS = ["billingName", "billingEmail", "billingAddress", "taxId", "paymentTerms"] as const;
const DUPLICATE_KEY_FIELDS = ["name", "email", "phone"] as const;

/** JSON columns need `DbNull` to store SQL NULL. */
function jsonColumn(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonObject);
}

const definedKeys = (value: object): string[] =>
  Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key]) => key);

/**
 * Audit values: billing columns are recorded by NAME only. The audit log is readable by people who
 * hold no billing grant, so a tax id must not be copied into it.
 */
function auditSafe(values: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  const billing: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if ((BILLING_FIELDS as readonly string[]).includes(key)) billing.push(key);
    else safe[key] = value;
  }
  return billing.length > 0 ? { ...safe, billingFieldsChanged: billing } : safe;
}

/**
 * What a write may show its caller: the `customers.view` decision on the record AFTER the change,
 * limited to the sets the write grant also covers (never wider than the caller could write or view).
 * Falls back to `{ id }` when the caller may no longer see the record (e.g. moved out of scope).
 */
async function viewAfterWrite(
  tx: TenantTx,
  actor: Actor,
  customerId: string,
  writeDecision: AccessDecision,
): Promise<Record<string, unknown>> {
  const row = await tx.customer.findFirst({ where: { id: customerId, tenantId: actor.tenantId }, select: customerRowSelect });
  if (!row) throw new NotFoundError();
  const attributes = (await customerRowAttributes(tx, actor.tenantId, [row])).get(row.id);
  if (!attributes) throw new NotFoundError();
  const view = await canInTx(tx, actor, "customers.view", toResourceRef(row, attributes));
  if (!view.allowed) return { id: row.id };
  const shared = view.fieldSets.filter((set) => set === "base" || writeDecision.fieldSets.includes(set));
  const addresses = await activeAddresses(tx, actor.tenantId, row.id);
  return projectFields(customerView(row, addresses), { allowed: true, fieldSets: shared }, CUSTOMER_API_FIELD_MAP);
}

async function activeAddresses(tx: TenantTx, tenantId: string, customerId: string) {
  const rows = await tx.customerAddress.findMany({
    where: { tenantId, customerId, archivedAt: null },
    select: ADDRESS_COLUMNS,
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(addressView);
}

/** Duplicate flags of a just-written customer that the caller is allowed to know about (both sides in scope). */
async function revealableDuplicates(tx: TenantTx, actor: Actor, open: OpenDuplicate[]): Promise<OpenDuplicate[]> {
  const visible = await visibleCustomerIds(tx, actor, open.map((entry) => entry.customerId));
  return open.filter((entry) => visible.has(entry.customerId));
}

/**
 * Creates a customer (and optional service addresses). Needs `customers.create` over the service-area
 * unit; without a unit the customer is tenant-level and a tenant-wide grant is required. A grant
 * qualified by a record set (Lead Operations: `lead_related`) is judged as if the new customer belongs
 * to every set: a record that does not exist yet has no history to qualify it, and the creator's
 * role is the context.
 * The response carries `possibleDuplicates` (open flags the caller may see); the write is never blocked by them.
 */
export async function createCustomer(
  actor: Actor,
  ctx: RequestContext,
  input: CreateCustomerInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const { addresses, ...fields } = input;
    const orgUnitId = fields.orgUnitId ?? null;
    const newRecord = { assignedEmployeeIds: [], sets: [...CUSTOMER_RECORD_SETS] };

    let decision: AccessDecision;
    if (orgUnitId) {
      decision = await assertServiceAreaUsable(tx, actor, "customers.create", orgUnitId, newRecord);
    } else {
      try {
        decision = await enforceInTx(tx, actor, "customers.create", newRecord);
      } catch (error) {
        // Creating has no existing record to hide: a missing tenant-wide grant is a plain 403.
        throw error instanceof NotFoundError ? new ForbiddenError() : error;
      }
    }
    assertWritableFields(decision, definedKeys(fields), CUSTOMER_FIELD_MAP);

    const phoneE164 = fields.phone ? normalizePhoneE164(fields.phone) : null;
    const customer = await tx.customer.create({
      data: {
        tenantId: actor.tenantId,
        number: await nextNumber(tx, actor.tenantId, "customer"),
        kind: fields.kind,
        name: fields.name,
        email: fields.email ?? null,
        phone: fields.phone ?? null,
        phoneE164,
        preferredLocale: fields.preferredLocale ?? null,
        preferredContactChannel: fields.preferredContactChannel ?? null,
        contactPreferences: jsonColumn(fields.contactPreferences),
        doNotContact: fields.doNotContact,
        orgUnitId,
        billingName: fields.billingName ?? null,
        billingEmail: fields.billingEmail ?? null,
        billingAddress: jsonColumn(fields.billingAddress),
        taxId: fields.taxId ?? null,
        paymentTerms: fields.paymentTerms ?? null,
        createdById: actor.userId,
      },
      select: { id: true },
    });

    const customerRef = { ...newRecord, ...(orgUnitId ? { orgUnitId } : {}) };
    await insertAddresses(tx, actor, "customers.create", customer.id, addresses, customerRef);
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer.create",
      targetType: "Customer",
      targetId: customer.id,
      newValue: { ...auditSafe(fields), phoneE164, addressCount: addresses.length },
    });

    const possibleDuplicates = await revealableDuplicates(tx, actor, await flagCustomerDuplicates(tx, ctx, customer.id));
    return { ...(await viewAfterWrite(tx, actor, customer.id, decision)), possibleDuplicates };
  });
}

/**
 * Edits a customer (partial). Needs `customers.edit` over the customer and, per changed column, the
 * field set that protects it. Moving the service area needs the permission over the destination unit
 * too (moving to "no unit" needs a tenant-wide grant). Archived customers are read-only: restore first.
 */
export async function updateCustomer(
  actor: Actor,
  ctx: RequestContext,
  customerId: string,
  input: UpdateCustomerInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.edit");
    const ref = await customerResourceRef(tx, actor.tenantId, customerId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "customers.edit", ref);

    const patch: Record<string, unknown> = { ...input };
    if (input.phone !== undefined) patch.phoneE164 = input.phone ? normalizePhoneE164(input.phone) : null;
    assertWritableFields(decision, definedKeys(patch), CUSTOMER_FIELD_MAP);

    const current = await tx.customer.findFirst({ where: { id: customerId, tenantId: actor.tenantId }, select: customerRowSelect });
    if (!current) throw new NotFoundError();
    if (current.archivedAt) throw new InvalidStateTransitionError({ message: "An archived customer cannot be edited. Restore it first." });

    const { changedKeys, previous, next } = changedFields(current, patch);
    if (changedKeys.length === 0) return viewAfterWrite(tx, actor, customerId, decision);

    if (changedKeys.includes("orgUnitId")) {
      if (input.orgUnitId) await assertServiceAreaUsable(tx, actor, "customers.edit", input.orgUnitId, ref);
      else await enforceInTx(tx, actor, "customers.edit", {});
    }

    await tx.customer.update({
      where: { id: customerId },
      data: {
        ...input,
        phoneE164: patch.phoneE164 as string | null | undefined,
        contactPreferences: jsonColumn(input.contactPreferences),
        billingAddress: jsonColumn(input.billingAddress),
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer.update",
      targetType: "Customer",
      targetId: customerId,
      previousValue: auditSafe(previous),
      newValue: auditSafe(next),
    });

    const flagged = (DUPLICATE_KEY_FIELDS as readonly string[]).some((field) => changedKeys.includes(field as never));
    const possibleDuplicates = flagged ? await revealableDuplicates(tx, actor, await flagCustomerDuplicates(tx, ctx, customerId)) : [];
    return { ...(await viewAfterWrite(tx, actor, customerId, decision)), possibleDuplicates };
  });
}

/** Archives a customer (soft remove: leads, jobs and history keep pointing at it). Needs `customers.archive`. */
export async function archiveCustomer(
  actor: Actor,
  ctx: RequestContext,
  customerId: string,
  input: ArchiveCustomerInput,
): Promise<Record<string, unknown>> {
  return setArchived(actor, ctx, customerId, true, input.reason);
}

/** Brings an archived customer back. Needs `customers.archive` (the reverse of archiving). */
export async function restoreCustomer(
  actor: Actor,
  ctx: RequestContext,
  customerId: string,
  input: ArchiveCustomerInput,
): Promise<Record<string, unknown>> {
  return setArchived(actor, ctx, customerId, false, input.reason);
}

async function setArchived(
  actor: Actor,
  ctx: RequestContext,
  customerId: string,
  archive: boolean,
  reason: string | undefined,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.archive");
    const ref = await customerResourceRef(tx, actor.tenantId, customerId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "customers.archive", ref);

    const current = await tx.customer.findFirst({ where: { id: customerId, tenantId: actor.tenantId }, select: { archivedAt: true } });
    if (!current) throw new NotFoundError();
    if (archive && current.archivedAt) throw new InvalidStateTransitionError({ message: "The customer is already archived." });
    if (!archive && !current.archivedAt) throw new InvalidStateTransitionError({ message: "The customer is not archived." });

    const archivedAt = archive ? new Date() : null;
    await tx.customer.update({ where: { id: customerId }, data: { archivedAt } });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: archive ? "customer.archive" : "customer.restore",
      targetType: "Customer",
      targetId: customerId,
      previousValue: { archivedAt: current.archivedAt },
      newValue: { archivedAt },
      reason,
    });
    // A restored customer may now duplicate one created while it was archived.
    if (!archive) await flagCustomerDuplicates(tx, ctx, customerId);
    return viewAfterWrite(tx, actor, customerId, decision);
  });
}

/** One customer with its active addresses (`customers.view` over it); outside the caller's scope it is a 404. Fields follow the grant. */
export async function getCustomer(actor: Actor, customerId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.view");
    const ref = await customerResourceRef(tx, actor.tenantId, customerId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "customers.view", ref);
    const row = await tx.customer.findFirst({ where: { id: customerId, tenantId: actor.tenantId }, select: customerRowSelect });
    if (!row) throw new NotFoundError();
    return projectFields(customerView(row, await activeAddresses(tx, actor.tenantId, row.id)), decision, CUSTOMER_API_FIELD_MAP);
  });
}

/** The where-fragment of the `q` search: name, email, partial phone digits, or customer number (`#1234`). */
function searchWhere(term: string): Prisma.CustomerWhereInput {
  const conditions: Prisma.CustomerWhereInput[] = [
    { name: { contains: term, mode: "insensitive" } },
    { email: { contains: term, mode: "insensitive" } },
  ];
  const digits = phoneSearchDigits(term);
  if (digits) conditions.push({ phoneE164: { contains: digits } });
  const numeric = /^#?(\d{1,9})$/.exec(term);
  if (numeric) conditions.push({ number: Number(numeric[1]) });
  return { OR: conditions };
}

/**
 * One page of customers the caller may see, ordered by name then id. The data scope (including
 * record-set grants) is part of the query, and each row is projected with the field sets of the
 * grants that cover THAT row, so a billing grant on one city never leaks into another city's rows.
 */
export async function listCustomers(actor: Actor, query: ListCustomersQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customers.view");
    const now = new Date();
    const access = await resolveCustomerListAccess(tx, actor, "customers.view", now);

    const callerWhere: Prisma.CustomerWhereInput = {
      tenantId: actor.tenantId,
      ...(query.archived === "exclude" ? { archivedAt: null } : query.archived === "only" ? { archivedAt: { not: null } } : {}),
      ...(query.orgUnitId ? { orgUnitId: query.orgUnitId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.preferredLocale ? { preferredLocale: query.preferredLocale } : {}),
      ...(query.q ? searchWhere(query.q) : {}),
    };
    const rows: CustomerRow[] = await tx.customer.findMany({
      where: withinScope(access.where, callerWhere),
      select: customerRowSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const attributes = await customerRowAttributes(tx, actor.tenantId, page.data, now);
    // Search and filters match BASE columns (name, kind, unit...). A row the caller sees only through a
    // billing-only grant must not be findable that way, or the filter becomes an oracle for hidden values.
    const filtersOnBaseColumns = Boolean(query.q || query.orgUnitId || query.kind || query.preferredLocale) || query.archived !== "exclude";
    const data = page.data.flatMap((row) => {
      const rowAttributes = attributes.get(row.id);
      const fieldSets = rowAttributes ? access.fieldSetsOf(rowAttributes) : [];
      if (filtersOnBaseColumns && !fieldSets.includes("base")) return [];
      return [projectFields(customerView(row), { allowed: true, fieldSets }, CUSTOMER_API_FIELD_MAP)];
    });
    return { data, page: page.page };
  });
}
