import type { Prisma } from "@prisma/client";
import { normalizeAddressKey } from "@/lib/address-key";
import { changedFields } from "@/lib/changed-fields";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx, type ResourceRef } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { customerResourceRef } from "./customer-access";
import { flagCustomerDuplicates } from "./duplicate-detection";
import { ADDRESS_COLUMNS, addressView, type AddressView } from "./fields";
import { assertServiceAreaUsable } from "./service-area";
import type { CreateAddressInput, UpdateAddressInput } from "./schemas";

/**
 * Service addresses of a customer (§6.1). Reads need `customers.view` over the customer; changes need
 * `customers.edit` with the `base` field set. Exactly one active address is the primary one (the first
 * address added, or the one flagged `isPrimary`). Coordinates exist only when entered (§28.3: no
 * geocoding provider), so a missing pair means "distance unknown", never a guess. Every write
 * refreshes duplicate detection for the customer (address matcher).
 */

/** Same customer, same moment: address changes are serialised so two "make primary" requests cannot both win. */
async function lockCustomerAddresses(tx: TenantTx, customerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-addresses:${customerId}`}))`;
}

/** The customer-level gate shared by every address operation: the customer exists in scope and the grant covers `base`. */
async function enforceOnCustomer(tx: TenantTx, actor: Actor, permission: "customers.view" | "customers.edit", customerId: string) {
  await enforceInTx(tx, actor, permission);
  const ref = await customerResourceRef(tx, actor.tenantId, customerId);
  if (!ref) throw new NotFoundError();
  const decision = await enforceInTx(tx, actor, permission, ref);
  if (permission === "customers.edit" && !decision.fieldSets.includes("base")) throw new ForbiddenError();
  return { decision, ref };
}

function addressData(input: CreateAddressInput) {
  const hasCoordinates = input.latitude !== undefined && input.latitude !== null;
  return {
    label: input.label ?? null,
    line1: input.line1,
    line2: input.line2 ?? null,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    countryCode: input.countryCode,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    coordinateSource: hasCoordinates ? "manual" : null,
    accessInstructions: input.accessInstructions ?? null,
    orgUnitId: input.orgUnitId ?? null,
    normalizedKey: normalizeAddressKey(input),
  };
}

/**
 * Inserts `inputs` for a customer inside the caller's transaction (used by customer creation and by
 * `addAddress`). The first address of a customer without an active one becomes primary unless the
 * caller named another. The caller owns locking, permission checks and duplicate detection.
 */
export async function insertAddresses(
  tx: TenantTx,
  actor: Actor,
  permission: "customers.create" | "customers.edit",
  customerId: string,
  inputs: CreateAddressInput[],
  customerRef: ResourceRef,
): Promise<AddressView[]> {
  const created: AddressView[] = [];
  const hasPrimary = (await tx.customerAddress.count({ where: { tenantId: actor.tenantId, customerId, isPrimary: true, archivedAt: null } })) > 0;
  const requestedPrimary = inputs.findIndex((input) => input.isPrimary);
  const primaryIndex = requestedPrimary >= 0 ? requestedPrimary : hasPrimary ? -1 : 0;
  if (requestedPrimary >= 0) {
    await tx.customerAddress.updateMany({ where: { tenantId: actor.tenantId, customerId, isPrimary: true }, data: { isPrimary: false } });
  }
  for (const [index, input] of inputs.entries()) {
    if (input.orgUnitId) await assertServiceAreaUsable(tx, actor, permission, input.orgUnitId, customerRef);
    const row = await tx.customerAddress.create({
      data: { tenantId: actor.tenantId, customerId, ...addressData(input), isPrimary: index === primaryIndex },
      select: ADDRESS_COLUMNS,
    });
    created.push(addressView(row));
  }
  return created;
}

/** Active addresses of a customer, primary first. Pass `includeArchived` for the full history. */
export async function listAddresses(actor: Actor, customerId: string, includeArchived = false): Promise<AddressView[]> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceOnCustomer(tx, actor, "customers.view", customerId);
    const rows = await tx.customerAddress.findMany({
      where: { tenantId: actor.tenantId, customerId, ...(includeArchived ? {} : { archivedAt: null }) },
      select: ADDRESS_COLUMNS,
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(addressView);
  });
}

/** Adds a service address. Needs `customers.edit` over the customer (and over the address's own service area, if it names one). */
export async function addAddress(actor: Actor, ctx: RequestContext, customerId: string, input: CreateAddressInput) {
  return withTenant(actor.tenantId, async (tx) => {
    const { ref } = await enforceOnCustomer(tx, actor, "customers.edit", customerId);
    await lockCustomerAddresses(tx, customerId);
    const [address] = await insertAddresses(tx, actor, "customers.edit", customerId, [input], ref);
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer.address_add",
      targetType: "CustomerAddress",
      targetId: address.id,
      newValue: { customerId, ...input },
    });
    const possibleDuplicates = await flagCustomerDuplicates(tx, ctx, customerId);
    return { address, possibleDuplicates };
  });
}

/** Edits an address (partial). Changing the postal address recomputes its duplicate-matching key. */
export async function updateAddress(
  actor: Actor,
  ctx: RequestContext,
  customerId: string,
  addressId: string,
  input: UpdateAddressInput,
) {
  return withTenant(actor.tenantId, async (tx) => {
    const { ref } = await enforceOnCustomer(tx, actor, "customers.edit", customerId);
    await lockCustomerAddresses(tx, customerId);
    const current = await tx.customerAddress.findFirst({ where: { id: addressId, customerId, tenantId: actor.tenantId }, select: ADDRESS_COLUMNS });
    if (!current) throw new NotFoundError();
    if (current.archivedAt) throw new InvalidStateTransitionError({ message: "An archived address cannot be edited." });

    const merged = { ...addressView(current), ...input };
    const nextLatitude = merged.latitude ?? null;
    const nextLongitude = merged.longitude ?? null;
    if ((nextLatitude === null) !== (nextLongitude === null)) {
      throw new ValidationError({ message: "Latitude and longitude go together.", field: "longitude" });
    }
    if (input.isPrimary === false && current.isPrimary) {
      throw new ValidationError({ message: "Make another address primary instead.", field: "isPrimary" });
    }
    const { isPrimary, ...columnChanges } = input;
    const comparable = addressView(current);
    const { changedKeys, previous, next } = changedFields(comparable, { ...columnChanges, ...(isPrimary === undefined ? {} : { isPrimary }) });
    if (changedKeys.length === 0) return { address: comparable, possibleDuplicates: [] };

    if (input.orgUnitId) await assertServiceAreaUsable(tx, actor, "customers.edit", input.orgUnitId, ref);
    if (isPrimary === true) {
      await tx.customerAddress.updateMany({ where: { tenantId: actor.tenantId, customerId, isPrimary: true }, data: { isPrimary: false } });
    }
    const coordinatesChanged = "latitude" in input || "longitude" in input;
    const data: Prisma.CustomerAddressUncheckedUpdateInput = {
      ...columnChanges,
      ...(isPrimary === undefined ? {} : { isPrimary }),
      normalizedKey: normalizeAddressKey({
        line1: merged.line1,
        line2: merged.line2,
        city: merged.city,
        region: merged.region,
        postalCode: merged.postalCode,
        countryCode: merged.countryCode,
      }),
      ...(coordinatesChanged ? { coordinateSource: nextLatitude === null ? null : "manual" } : {}),
    };
    const updated = await tx.customerAddress.update({ where: { id: addressId }, data, select: ADDRESS_COLUMNS });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer.address_update",
      targetType: "CustomerAddress",
      targetId: addressId,
      previousValue: previous,
      newValue: next,
    });
    const possibleDuplicates = await flagCustomerDuplicates(tx, ctx, customerId);
    return { address: addressView(updated), possibleDuplicates };
  });
}

/**
 * Archives an address (soft: jobs keep pointing at it). When it was the primary one, the oldest
 * remaining active address takes over so a customer with addresses always has a primary.
 */
export async function archiveAddress(actor: Actor, ctx: RequestContext, customerId: string, addressId: string) {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceOnCustomer(tx, actor, "customers.edit", customerId);
    await lockCustomerAddresses(tx, customerId);
    const address = await tx.customerAddress.findFirst({ where: { id: addressId, customerId, tenantId: actor.tenantId }, select: ADDRESS_COLUMNS });
    if (!address) throw new NotFoundError();
    if (address.archivedAt) throw new InvalidStateTransitionError({ message: "The address is already archived." });

    const archived = await tx.customerAddress.update({
      where: { id: addressId },
      data: { archivedAt: new Date(), isPrimary: false },
      select: ADDRESS_COLUMNS,
    });
    let promotedAddressId: string | null = null;
    if (address.isPrimary) {
      const next = await tx.customerAddress.findFirst({
        where: { tenantId: actor.tenantId, customerId, archivedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (next) {
        await tx.customerAddress.update({ where: { id: next.id }, data: { isPrimary: true } });
        promotedAddressId = next.id;
      }
    }
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer.address_archive",
      targetType: "CustomerAddress",
      targetId: addressId,
      previousValue: { archivedAt: null },
      newValue: { archivedAt: archived.archivedAt, promotedAddressId },
    });
    return addressView(archived);
  });
}
