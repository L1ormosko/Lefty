import type { Prisma } from "@prisma/client";
import { CUSTOMER_FIELD_MAP, type FieldMap } from "@/server/authz";
import { customerScopeSelect } from "./customer-access";

/**
 * Customer fields returned by the API. `CUSTOMER_FIELD_MAP` (authz) classifies every stored column,
 * billing columns included (opt-in `billing` set); `addresses` is a derived list of the customer's
 * active service addresses and is base data. Anything not in the map is dropped by projection.
 */
export const CUSTOMER_API_FIELD_MAP: FieldMap = { ...CUSTOMER_FIELD_MAP, addresses: "base" };

/** Stored columns that are returned (subject to projection); `tenantId` never leaves the server. */
export const CUSTOMER_COLUMNS = {
  id: true,
  number: true,
  kind: true,
  name: true,
  email: true,
  phone: true,
  phoneE164: true,
  preferredLocale: true,
  preferredContactChannel: true,
  contactPreferences: true,
  doNotContact: true,
  orgUnitId: true,
  billingName: true,
  billingEmail: true,
  billingAddress: true,
  taxId: true,
  paymentTerms: true,
  archivedAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

/** Columns plus what scope matching needs (`customerScopeSelect`). */
export const customerRowSelect = { ...CUSTOMER_COLUMNS, ...customerScopeSelect } satisfies Prisma.CustomerSelect;

export type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof customerRowSelect }>;

/** Address columns returned by the API (coordinates become plain numbers; `tenantId` stays server-side). */
export const ADDRESS_COLUMNS = {
  id: true,
  customerId: true,
  label: true,
  line1: true,
  line2: true,
  city: true,
  region: true,
  postalCode: true,
  countryCode: true,
  latitude: true,
  longitude: true,
  coordinateSource: true,
  accessInstructions: true,
  isPrimary: true,
  orgUnitId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerAddressSelect;

type AddressRow = Prisma.CustomerAddressGetPayload<{ select: typeof ADDRESS_COLUMNS }>;

/** Prisma `Decimal` coordinates are serialized as numbers: the API promises JSON numbers, not strings. */
export function addressView(row: AddressRow) {
  return {
    ...row,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
  };
}
export type AddressView = ReturnType<typeof addressView>;

/**
 * A fetched customer as the API shape, before projection: scope helper columns are dropped, active
 * addresses attached when given (single-customer reads). `projectFields` then removes whatever the caller's grant does not reveal.
 */
export function customerView(row: CustomerRow, addresses?: AddressView[]): Record<string, unknown> {
  const { orgUnit: _orgUnit, ...columns } = row;
  return addresses ? { ...columns, addresses } : columns;
}
