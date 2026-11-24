import { z } from "zod";
import { COMPLETION_FIELD_KEYS } from "@/lib/completion-form-rules";
import { pageQuerySchema } from "@/server/core";
import { fieldEventEnvelope } from "@/server/location";

/** Zod schemas of the field-execution API (§8.5, §8.6). Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
/** §11.8: money is integer minor units, never a float. */
const money = z.number().int().min(0).max(2_000_000_000);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "ISO 4217 code");

export const jobIdParams = z.object({ id });
export const completionFormIdParams = z.object({ id });
export const attachmentParams = z.object({ id, attachmentId: id });

/** Offline envelope (§8.7): `clientEventId` makes the write idempotent, `occurredAt` is the device time. `deviceId` is accepted for symmetry with the other field writes. */
const envelope = fieldEventEnvelope;

export const FIELD_NOTE_KINDS = ["NOTE", "WORK_PERFORMED", "ADDITIONAL_WORK_REQUESTED", "CUSTOMER_APPROVAL"] as const;

/**
 * One note of the visit. `ADDITIONAL_WORK_REQUESTED` records work the customer asked for beyond the job (with an
 * optional estimate); `CUSTOMER_APPROVAL` records that the customer approved or declined (`customerApproved`),
 * optionally with the amount. Free text lives in `body` only; events carry ids.
 */
export const recordFieldNoteSchema = z
  .object({
    ...envelope,
    kind: z.enum(FIELD_NOTE_KINDS).default("NOTE"),
    body: text(4000),
    amountMinor: money.optional(),
    /** Defaults to the job's currency. */
    currency: currency.optional(),
    customerApproved: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mayCarryAmount = value.kind === "ADDITIONAL_WORK_REQUESTED" || value.kind === "CUSTOMER_APPROVAL";
    if (value.amountMinor !== undefined && !mayCarryAmount) context.addIssue({ code: "custom", path: ["amountMinor"], message: "Only additional work and customer approval carry an amount" });
    if (value.currency !== undefined && value.amountMinor === undefined) context.addIssue({ code: "custom", path: ["currency"], message: "A currency needs an amount" });
    if (value.kind === "CUSTOMER_APPROVAL" && value.customerApproved === undefined) context.addIssue({ code: "custom", path: ["customerApproved"], message: "Say whether the customer approved" });
    if (value.kind !== "CUSTOMER_APPROVAL" && value.customerApproved !== undefined) context.addIssue({ code: "custom", path: ["customerApproved"], message: "Only a customer approval has a decision" });
  });
export type RecordFieldNoteInput = z.infer<typeof recordFieldNoteSchema>;

/** Quantity has at most three decimals (`Decimal(12,3)`). */
const quantity = z
  .number()
  .positive()
  .max(999_999_999)
  .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6, { message: "At most three decimals" });

/** A material used on the job. `materialRef` is the placeholder for the Phase 4 catalog; today the name is free text. */
export const recordMaterialSchema = z
  .object({
    ...envelope,
    name: text(200),
    quantity,
    unit: text(30).default("each"),
    materialRef: text(100).optional(),
    note: text(500).optional(),
  })
  .strict();
export type RecordMaterialInput = z.infer<typeof recordMaterialSchema>;

export const ATTACHMENT_KINDS = ["PHOTO", "SIGNATURE", "DOCUMENT"] as const;

/**
 * Metadata of a file captured on the device. No file bytes travel here (there is no storage provider yet): the row is
 * `PENDING_UPLOAD` until a provider is configured and the upload is made.
 */
export const recordAttachmentSchema = z
  .object({
    ...envelope,
    kind: z.enum(ATTACHMENT_KINDS).default("PHOTO"),
    fileName: text(255),
    contentType: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, "A media type such as image/jpeg").max(100),
    sizeBytes: z.number().int().min(1).max(104_857_600),
    checksumSha256: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, "64 hex characters").optional(),
    caption: text(500).optional(),
    /** When the file was captured on the device. */
    capturedAt: instant.optional(),
  })
  .strict();
export type RecordAttachmentInput = z.infer<typeof recordAttachmentSchema>;

/**
 * Submitting the completion form of the job's current visit. Amounts, payment, materials and photos are NOT repeated
 * here: they are the visit's outcome, material rows and attachments, which the form definition requires to exist.
 */
export const submitCompletionSchema = z
  .object({
    ...envelope,
    notes: text(4000).optional(),
    workPerformed: text(4000).optional(),
    followUpRequired: z.boolean().optional(),
    /** A SIGNATURE attachment of this job. */
    signatureAttachmentId: id.optional(),
  })
  .strict();
export type SubmitCompletionInput = z.infer<typeof submitCompletionSchema>;

export const listFieldRecordsQuerySchema = pageQuerySchema;
export type ListFieldRecordsQuery = z.infer<typeof listFieldRecordsQuerySchema>;

// ─────────────────────── Completion form definitions (§8.6) ───────────────────────

const fieldSpec = z
  .object({
    key: z.enum(COMPLETION_FIELD_KEYS),
    type: z.enum(["select", "money", "text", "longtext", "boolean", "materials", "photos", "signature"]),
    required: z.boolean(),
    labelKey: z.string().trim().min(3).max(120),
  })
  .strict();
const formSchema = z.object({ fields: z.array(fieldSpec).min(1).max(COMPLETION_FIELD_KEYS.length) }).strict();

/** A new DRAFT version for ONE job type XOR ONE category; the version number is assigned by the server. */
export const createCompletionFormSchema = z
  .object({
    jobTypeId: id.optional(),
    category: text(80).optional(),
    name: text(200),
    schema: formSchema,
  })
  .strict()
  .refine((value) => (value.jobTypeId === undefined) !== (value.category === undefined), { path: ["jobTypeId"], message: "Name a job type or a category, not both" });
export type CreateCompletionFormInput = z.infer<typeof createCompletionFormSchema>;

export const updateCompletionFormSchema = z
  .object({ name: text(200).optional(), schema: formSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });
export type UpdateCompletionFormInput = z.infer<typeof updateCompletionFormSchema>;

export const listCompletionFormsQuerySchema = pageQuerySchema.extend({
  jobTypeId: id.optional(),
  category: z.string().trim().min(1).max(80).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "RETIRED"]).optional(),
});
export type ListCompletionFormsQuery = z.infer<typeof listCompletionFormsQuerySchema>;
