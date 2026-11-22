import { z } from "zod";
import { normalizePhoneE164 } from "@/lib/phone";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas for the customers API. Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);
const email = z.string().trim().toLowerCase().email().max(254);

/** A phone as typed by a person. The service stores the E.164 form next to it; unusable input is a field error. */
const phone = z
  .string()
  .trim()
  .min(5)
  .max(32)
  .regex(/^[+0-9 ()\-.]+(?:\s*(?:ext\.?|x)\s*\d+)?$/i, "Digits, spaces and + ( ) - . only (optional extension: x123)")
  .refine((value) => normalizePhoneE164(value) !== null, "Enter a US/Canada number or use the international form (+...)");

const LOCALES = ["en-US", "es-US", "he-IL"] as const;
const CHANNELS = ["PHONE", "SMS", "EMAIL", "IN_PERSON", "CHAT", "OTHER"] as const;

/** Free-form preferences (quiet hours, do-not-text windows). Kept small so it cannot become a document store. */
const contactPreferences = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 4000, "Too large (4000 characters at most)");

const billingAddress = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 2000, "Too large (2000 characters at most)");

export const customerAddressFields = {
  label: text(80).nullish(),
  line1: text(200),
  line2: text(200).nullish(),
  city: text(120),
  /** State / province / region. */
  region: text(120),
  postalCode: text(20),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2").default("US"),
  /** Optional: no geocoding provider is integrated (§28.3), so coordinates exist only when entered. */
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  accessInstructions: text(2000).nullish(),
  isPrimary: z.boolean().optional(),
  /** Service-area org unit of this address (copied to jobs created for it). */
  orgUnitId: id.nullish(),
};

const coordinatesArePaired = (value: { latitude?: number | null; longitude?: number | null }): boolean =>
  (value.latitude === undefined || value.latitude === null) === (value.longitude === undefined || value.longitude === null);

export const createAddressSchema = z
  .object(customerAddressFields)
  .strict()
  .refine(coordinatesArePaired, { path: ["longitude"], message: "Latitude and longitude go together" });
export type CreateAddressInput = z.infer<typeof createAddressSchema>;

export const updateAddressSchema = z
  .object({
    label: customerAddressFields.label,
    line1: customerAddressFields.line1.optional(),
    line2: customerAddressFields.line2,
    city: customerAddressFields.city.optional(),
    region: customerAddressFields.region.optional(),
    postalCode: customerAddressFields.postalCode.optional(),
    countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2").optional(),
    latitude: customerAddressFields.latitude,
    longitude: customerAddressFields.longitude,
    accessInstructions: customerAddressFields.accessInstructions,
    isPrimary: z.boolean().optional(),
    orgUnitId: customerAddressFields.orgUnitId,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;

/** Base (non-sensitive) customer fields: what a plain `customers.create|edit` grant may write. */
const baseCustomerFields = {
  kind: z.enum(["INDIVIDUAL", "BUSINESS"]),
  name: text(200),
  email: email.nullish(),
  phone: phone.nullish(),
  preferredLocale: z.enum(LOCALES).nullish(),
  preferredContactChannel: z.enum(CHANNELS).nullish(),
  contactPreferences: contactPreferences.nullish(),
  doNotContact: z.boolean(),
  /** Service-area org unit (branch/city). Drives ORG_UNIT scope; omit only with a tenant-wide grant. */
  orgUnitId: id.nullish(),
};

/** Billing set (`customers.billing_fields`): accepted only from grants that name it (checked in the service). */
const billingCustomerFields = {
  billingName: text(200).nullish(),
  billingEmail: email.nullish(),
  billingAddress: billingAddress.nullish(),
  taxId: text(64).nullish(),
  paymentTerms: text(120).nullish(),
};

export const createCustomerSchema = z
  .object({
    ...baseCustomerFields,
    kind: baseCustomerFields.kind.default("INDIVIDUAL"),
    doNotContact: baseCustomerFields.doNotContact.default(false),
    ...billingCustomerFields,
    /** Service addresses created together with the customer (the first one becomes the primary). */
    addresses: z.array(createAddressSchema).max(20).default([]),
  })
  .strict();
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    kind: baseCustomerFields.kind.optional(),
    name: baseCustomerFields.name.optional(),
    email: baseCustomerFields.email,
    phone: baseCustomerFields.phone,
    preferredLocale: baseCustomerFields.preferredLocale,
    preferredContactChannel: baseCustomerFields.preferredContactChannel,
    contactPreferences: baseCustomerFields.contactPreferences,
    doNotContact: baseCustomerFields.doNotContact.optional(),
    orgUnitId: baseCustomerFields.orgUnitId,
    ...billingCustomerFields,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const listCustomersQuerySchema = pageQuerySchema.extend({
  /** Name, email, phone (any format, partial) or customer number (`#1234`). */
  q: z.string().trim().min(1).max(100).optional(),
  /** Default `exclude`: archived customers are hidden unless asked for. */
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
  orgUnitId: id.optional(),
  kind: z.enum(["INDIVIDUAL", "BUSINESS"]).optional(),
  preferredLocale: z.enum(LOCALES).optional(),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

/** The body is optional (archiving needs no reason): an empty request means `{}`. */
export const archiveCustomerSchema = z.object({ reason: text(500).optional() }).strict().default({});
export type ArchiveCustomerInput = z.infer<typeof archiveCustomerSchema>;

export const createNoteSchema = z.object({ body: text(4000) }).strict();
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const listNotesQuerySchema = pageQuerySchema;

export const historyQuerySchema = z.object({
  /** Maximum number of leads and of jobs returned (each list separately), newest first. */
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/** The whole preference list is replaced (a customer has few of them), so the request is the new truth. */
export const setEmployeePreferencesSchema = z
  .object({
    preferences: z
      .array(z.object({ employeeId: id, kind: z.enum(["PREFERRED", "AVOID"]), note: text(500).nullish() }).strict())
      .max(50),
  })
  .strict()
  .refine((value) => new Set(value.preferences.map((entry) => entry.employeeId)).size === value.preferences.length, {
    path: ["preferences"],
    message: "An employee can be listed once",
  });
export type SetEmployeePreferencesInput = z.infer<typeof setEmployeePreferencesSchema>;

export const listDuplicatesQuerySchema = pageQuerySchema.extend({
  status: z.enum(["OPEN", "NOT_DUPLICATE", "CONFIRMED_DUPLICATE"]).default("OPEN"),
  /** Only flags that involve this customer. */
  customerId: id.optional(),
});
export type ListDuplicatesQuery = z.infer<typeof listDuplicatesQuerySchema>;

export const resolveDuplicateSchema = z
  .object({
    /** `NOT_DUPLICATE` = never flag this pair again; `CONFIRMED_DUPLICATE` = linked as the same party (no merge). */
    resolution: z.enum(["NOT_DUPLICATE", "CONFIRMED_DUPLICATE"]),
    note: text(500).optional(),
  })
  .strict();
export type ResolveDuplicateInput = z.infer<typeof resolveDuplicateSchema>;

/** Which matchers run on create/update (§6.4 "configurable matching"). All four must be sent: the request is the new truth. */
export const duplicateMatchersSchema = z
  .object({ phone: z.boolean(), email: z.boolean(), address: z.boolean(), name: z.boolean() })
  .strict();
export type DuplicateMatchersInput = z.infer<typeof duplicateMatchersSchema>;

export const customerIdParams = z.object({ id });
export const customerAddressParams = z.object({ id, addressId: id });
export const duplicateFlagParams = z.object({ flagId: id });
