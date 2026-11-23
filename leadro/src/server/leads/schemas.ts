import { z } from "zod";
import { LEAD_STATUSES } from "@/lib/lead-lifecycle";
import { normalizePhoneE164 } from "@/lib/phone";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas for the leads API. Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);
const email = z.string().trim().toLowerCase().email().max(254);
const instant = z.coerce.date();

const phone = z
  .string()
  .trim()
  .min(5)
  .max(32)
  .regex(/^[+0-9 ()\-.]+(?:\s*(?:ext\.?|x)\s*\d+)?$/i, "Digits, spaces and + ( ) - . only (optional extension: x123)")
  .refine((value) => normalizePhoneE164(value) !== null, "Enter a US/Canada number or use the international form (+...)");

const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
const CHANNELS = ["PHONE", "SMS", "EMAIL", "IN_PERSON", "CHAT", "OTHER"] as const;
const OUTCOMES = ["REACHED", "NO_ANSWER", "VOICEMAIL", "BUSY", "WRONG_NUMBER", "CALLBACK_REQUESTED", "DECLINED"] as const;
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "ISO 4217 code");

/**
 * The fields a lead is described by (§6.2). Contact and address are stored as received: a lead can arrive
 * before any customer exists and with an incomplete address (§25.1), so almost everything is optional.
 */
const leadContentFields = {
  priority: z.enum(PRIORITIES),
  campaign: text(120).nullish(),
  contactName: text(200).nullish(),
  contactPhone: phone.nullish(),
  contactEmail: email.nullish(),
  addressLine1: text(200).nullish(),
  addressLine2: text(200).nullish(),
  addressCity: text(120).nullish(),
  addressRegion: text(120).nullish(),
  addressPostalCode: text(20).nullish(),
  jobTypeId: id.nullish(),
  /** Category as received when no job type matches. */
  serviceCategory: text(120).nullish(),
  requestedWork: text(4000).nullish(),
  preferredWindowStart: instant.nullish(),
  preferredWindowEnd: instant.nullish(),
  preferredTimeNote: text(200).nullish(),
  notes: text(4000).nullish(),
  /** Integer minor units (§11.8: never floats). */
  quotedAmountMinor: z.number().int().min(0).max(2_000_000_000).nullish(),
  currency,
  /** Service-area org unit. Drives ORG_UNIT scope; omit only with a tenant-wide grant. */
  orgUnitId: id.nullish(),
  nextFollowUpAt: instant.nullish(),
};

const windowIsOrdered = (value: { preferredWindowStart?: Date | null; preferredWindowEnd?: Date | null }): boolean =>
  !value.preferredWindowStart || !value.preferredWindowEnd || value.preferredWindowEnd > value.preferredWindowStart;

export const createLeadSchema = z
  .object({
    ...leadContentFields,
    priority: leadContentFields.priority.default("NORMAL"),
    currency: leadContentFields.currency.default("USD"),
    /** Lead source by id or by its stable code (an integration usually knows the code). At most one of them. */
    sourceId: id.optional(),
    sourceCode: text(63).optional(),
    /** The lead's id in the sending system: with the source it makes webhook retries idempotent (§25.1). */
    externalId: text(200).optional(),
    /** A known customer (and one of ITS addresses) when the lead comes from an existing customer. */
    customerId: id.optional(),
    customerAddressId: id.optional(),
  })
  .strict()
  .refine((value) => !(value.sourceId && value.sourceCode), { path: ["sourceCode"], message: "Give sourceId or sourceCode, not both" })
  .refine((value) => !value.externalId || value.sourceId || value.sourceCode, {
    path: ["externalId"],
    message: "An external id needs a lead source",
  })
  .refine((value) => !value.customerAddressId || value.customerId, { path: ["customerAddressId"], message: "An address needs its customer" })
  .refine(windowIsOrdered, { path: ["preferredWindowEnd"], message: "The window must end after it starts" })
  .refine((value) => Boolean(value.contactName || value.contactPhone || value.contactEmail || value.customerId), {
    path: ["contactName"],
    message: "A lead needs a way to reach the customer: a name, phone, email or a known customer",
  });
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/** Editing never changes the status, the source, the customer link or the owner: they have their own actions. */
export const updateLeadSchema = z
  .object({
    priority: leadContentFields.priority.optional(),
    campaign: leadContentFields.campaign,
    contactName: leadContentFields.contactName,
    contactPhone: leadContentFields.contactPhone,
    contactEmail: leadContentFields.contactEmail,
    addressLine1: leadContentFields.addressLine1,
    addressLine2: leadContentFields.addressLine2,
    addressCity: leadContentFields.addressCity,
    addressRegion: leadContentFields.addressRegion,
    addressPostalCode: leadContentFields.addressPostalCode,
    jobTypeId: leadContentFields.jobTypeId,
    serviceCategory: leadContentFields.serviceCategory,
    requestedWork: leadContentFields.requestedWork,
    preferredWindowStart: leadContentFields.preferredWindowStart,
    preferredWindowEnd: leadContentFields.preferredWindowEnd,
    preferredTimeNote: leadContentFields.preferredTimeNote,
    notes: leadContentFields.notes,
    quotedAmountMinor: leadContentFields.quotedAmountMinor,
    currency: leadContentFields.currency.optional(),
    orgUnitId: leadContentFields.orgUnitId,
    nextFollowUpAt: leadContentFields.nextFollowUpAt,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change")
  .refine(windowIsOrdered, { path: ["preferredWindowEnd"], message: "The window must end after it starts" });
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const listLeadsQuerySchema = pageQuerySchema.extend({
  /** Name, email, phone (any format, partial) or lead number (`#1234`). */
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  sourceId: id.optional(),
  orgUnitId: id.optional(),
  customerId: id.optional(),
  /** `true`: only leads with an ACTIVE owner; `false`: only leads without one. */
  assigned: z.enum(["true", "false"]).optional(),
  /** Leads owned by this employee (`me` = the caller's own employee record). */
  assigneeEmployeeId: z.union([id, z.literal("me")]).optional(),
  /** `true`: only leads whose follow-up date has passed (a work queue). */
  followUpDue: z.enum(["true"]).optional(),
  /** Default `exclude`: archived leads are hidden unless asked for. */
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

/** A status change requested by a person. ASSIGNED and CONVERTED have their own actions (an owner / a job is needed). */
export const changeLeadStatusSchema = z
  .object({
    status: z.enum(LEAD_STATUSES),
    /** Required for LOST and CANCELLED; kept in the status history. */
    reason: text(500).optional(),
    /** Required for DUPLICATE: the lead this one duplicates. */
    duplicateOfLeadId: id.optional(),
  })
  .strict();
export type ChangeLeadStatusInput = z.infer<typeof changeLeadStatusSchema>;

export const assignLeadSchema = z
  .object({
    employeeId: id,
    /** Required when it replaces another owner, and whenever the §25.1 conflict is confirmed. */
    reason: text(500).optional(),
    /** §25.1: another employee has an open contact attempt on this lead; the assigner confirms the reassignment anyway. */
    confirmOpenContactAttempt: z.boolean().default(false),
    /** The employee works outside the lead's service area (wrong region, §25.1); the assigner confirms. */
    confirmOutsideServiceArea: z.boolean().default(false),
  })
  .strict();
export type AssignLeadInput = z.infer<typeof assignLeadSchema>;

export const unassignLeadSchema = z
  .object({
    reason: text(500),
    confirmOpenContactAttempt: z.boolean().default(false),
  })
  .strict();
export type UnassignLeadInput = z.infer<typeof unassignLeadSchema>;

/**
 * A contact attempt, note, customer message or follow-up. A CONTACT_ATTEMPT needs its channel; without an
 * `outcome` it is "in progress" (open, spec 25.1) until it is closed.
 */
export const createInteractionSchema = z
  .object({
    kind: z.enum(["CONTACT_ATTEMPT", "NOTE", "CUSTOMER_MESSAGE", "FOLLOW_UP"]),
    direction: z.enum(["OUTBOUND", "INBOUND", "INTERNAL"]).optional(),
    channel: z.enum(CHANNELS).optional(),
    outcome: z.enum(OUTCOMES).optional(),
    body: text(4000).optional(),
    occurredAt: instant.optional(),
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    /** The next follow-up date this interaction sets on the lead. */
    followUpAt: instant.optional(),
  })
  .strict()
  .refine((value) => value.kind !== "CONTACT_ATTEMPT" || value.channel, { path: ["channel"], message: "A contact attempt needs its channel" })
  .refine((value) => value.kind !== "FOLLOW_UP" || value.followUpAt, { path: ["followUpAt"], message: "A follow-up needs its due date" })
  .refine((value) => value.kind !== "NOTE" || value.body, { path: ["body"], message: "A note needs text" })
  .refine((value) => value.kind === "CONTACT_ATTEMPT" || !value.outcome, { path: ["outcome"], message: "Only a contact attempt has an outcome" });
export type CreateInteractionInput = z.infer<typeof createInteractionSchema>;

export const closeInteractionSchema = z
  .object({
    outcome: z.enum(OUTCOMES),
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    body: text(4000).optional(),
    followUpAt: instant.optional(),
  })
  .strict();
export type CloseInteractionInput = z.infer<typeof closeInteractionSchema>;

export const listInteractionsQuerySchema = pageQuerySchema.extend({
  kind: z.enum(["CONTACT_ATTEMPT", "NOTE", "CUSTOMER_MESSAGE", "FOLLOW_UP"]).optional(),
});
export type ListInteractionsQuery = z.infer<typeof listInteractionsQuerySchema>;

export const linkCustomerSchema = z.object({ customerId: id, customerAddressId: id.optional() }).strict();
export type LinkCustomerInput = z.infer<typeof linkCustomerSchema>;

/**
 * Conversion creates the job. Anything omitted is taken from the lead; the customer, its service address and the
 * job type must exist by then.
 */
export const convertLeadSchema = z
  .object({
    customerId: id.optional(),
    serviceAddressId: id.optional(),
    jobTypeId: id.optional(),
    description: text(4000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    appointmentWindowStart: instant.optional(),
    appointmentWindowEnd: instant.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.appointmentWindowStart) === Boolean(value.appointmentWindowEnd), {
    path: ["appointmentWindowEnd"],
    message: "Give both ends of the appointment window or neither",
  })
  .refine((value) => !value.appointmentWindowStart || !value.appointmentWindowEnd || value.appointmentWindowEnd > value.appointmentWindowStart, {
    path: ["appointmentWindowEnd"],
    message: "The window must end after it starts",
  });
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;

export const archiveLeadSchema = z.object({ reason: text(500).optional() }).strict().default({});
export type ArchiveLeadInput = z.infer<typeof archiveLeadSchema>;

export const listLeadDuplicatesQuerySchema = pageQuerySchema.extend({
  status: z.enum(["OPEN", "NOT_DUPLICATE", "CONFIRMED_DUPLICATE"]).default("OPEN"),
  leadId: id.optional(),
});
export type ListLeadDuplicatesQuery = z.infer<typeof listLeadDuplicatesQuerySchema>;

export const resolveLeadDuplicateSchema = z
  .object({ resolution: z.enum(["NOT_DUPLICATE", "CONFIRMED_DUPLICATE"]), note: text(500).optional() })
  .strict();
export type ResolveLeadDuplicateInput = z.infer<typeof resolveLeadDuplicateSchema>;

export const createLeadSourceSchema = z
  .object({
    code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "Lower-case letters, digits, - and _"),
    name: text(120),
    type: z.enum(["MANUAL", "PHONE", "WEBSITE", "MARKETING_CAMPAIGN", "EXTERNAL_CRM", "API", "IMPORT", "INTEGRATION"]),
  })
  .strict();
export type CreateLeadSourceInput = z.infer<typeof createLeadSourceSchema>;

export const updateLeadSourceSchema = z
  .object({ name: text(120).optional(), active: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateLeadSourceInput = z.infer<typeof updateLeadSourceSchema>;

export const leadIdParams = z.object({ id });
export const leadInteractionParams = z.object({ id, interactionId: id });
export const leadDuplicateFlagParams = z.object({ flagId: id });
export const leadSourceParams = z.object({ sourceId: id });
