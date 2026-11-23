import type { JobOutcomeType } from "@prisma/client";

/**
 * Development seed data for Phase 3 (field operations and recovery): the lost reasons every
 * field-service company starts with (spec 9.2), a default completion form per job type (spec 8.6)
 * and ONE example recovery rule (spec 9.6) that ships INACTIVE. Everything here is fictional defaults
 * a tenant is expected to edit.
 */

export interface LostReasonSpec {
  code: string;
  name: string;
  appliesTo: JobOutcomeType[];
  recoverable: boolean;
}

/** Spec 9.2 list. Order is the display order (`sortOrder`). */
export const LOST_REASONS: LostReasonSpec[] = [
  { code: "price-too-high", name: "Price too high", appliesTo: ["NOT_SOLD"], recoverable: true },
  { code: "customer-wants-to-think", name: "Customer wants to think", appliesTo: ["NOT_SOLD"], recoverable: true },
  { code: "customer-declined", name: "Customer declined", appliesTo: ["NOT_SOLD"], recoverable: true },
  { code: "customer-unavailable", name: "Customer unavailable", appliesTo: ["CUSTOMER_UNAVAILABLE", "RESCHEDULE_REQUIRED"], recoverable: true },
  { code: "customer-requested-another-appointment", name: "Customer requested another appointment", appliesTo: ["RESCHEDULE_REQUIRED", "CUSTOMER_UNAVAILABLE"], recoverable: true },
  { code: "missing-materials", name: "Missing materials", appliesTo: ["WORK_NOT_POSSIBLE", "RESCHEDULE_REQUIRED"], recoverable: true },
  { code: "missing-equipment", name: "Missing equipment", appliesTo: ["WORK_NOT_POSSIBLE", "RESCHEDULE_REQUIRED"], recoverable: true },
  { code: "outside-service-capabilities", name: "Work outside service capabilities", appliesTo: ["WORK_NOT_POSSIBLE", "NOT_SOLD"], recoverable: false },
  { code: "technical-issue", name: "Technical issue", appliesTo: ["WORK_NOT_POSSIBLE"], recoverable: true },
  {
    code: "other",
    name: "Other",
    appliesTo: ["NOT_SOLD", "WORK_NOT_POSSIBLE", "CUSTOMER_UNAVAILABLE", "RESCHEDULE_REQUIRED", "ADDITIONAL_APPROVAL_REQUIRED"],
    recoverable: true,
  },
];

/** Closed vocabulary of completion-form field keys (spec 8.6 "potential fields"). */
export type CompletionFieldKey =
  | "outcome"
  | "quotedAmount"
  | "approvedAmount"
  | "finalChargedAmount"
  | "amountCollected"
  | "paymentMethod"
  | "paymentStatus"
  | "materials"
  | "photos"
  | "notes"
  | "customerSignature"
  | "followUpRequired";

/**
 * One field of a completion form (an entry of `JobCompletionFormDefinition.schema.fields`).
 * Labels are i18n keys, never text.
 */
export interface CompletionFieldSpec {
  key: CompletionFieldKey;
  type: "select" | "money" | "text" | "longtext" | "boolean" | "materials" | "photos" | "signature";
  required: boolean;
  labelKey: string;
}

const field = (key: CompletionFieldKey, type: CompletionFieldSpec["type"], required: boolean): CompletionFieldSpec => ({
  key,
  type,
  required,
  labelKey: `COMPLETION_FORM.FIELD.${key}`,
});

/** Spec 8.6: "do not force every job type to use identical fields" - the default varies by job category. */
export const DEFAULT_FORM_FIELDS_BY_CATEGORY: Record<string, CompletionFieldSpec[]> = {
  installation: [
    field("outcome", "select", true),
    field("quotedAmount", "money", false),
    field("approvedAmount", "money", false),
    field("finalChargedAmount", "money", true),
    field("amountCollected", "money", true),
    field("paymentMethod", "select", true),
    field("paymentStatus", "select", true),
    field("materials", "materials", true),
    field("photos", "photos", true),
    field("notes", "longtext", false),
    field("customerSignature", "signature", true),
    field("followUpRequired", "boolean", false),
  ],
  repair: [
    field("outcome", "select", true),
    field("quotedAmount", "money", false),
    field("approvedAmount", "money", false),
    field("finalChargedAmount", "money", true),
    field("amountCollected", "money", false),
    field("paymentMethod", "select", false),
    field("paymentStatus", "select", true),
    field("materials", "materials", false),
    field("photos", "photos", false),
    field("notes", "longtext", true),
    field("customerSignature", "signature", false),
    field("followUpRequired", "boolean", false),
  ],
  inspection: [
    field("outcome", "select", true),
    field("quotedAmount", "money", false),
    field("photos", "photos", false),
    field("notes", "longtext", true),
    field("followUpRequired", "boolean", true),
  ],
};

/** Used for any category without its own entry (tenants add categories freely). */
export const FALLBACK_FORM_FIELDS: CompletionFieldSpec[] = [
  field("outcome", "select", true),
  field("finalChargedAmount", "money", false),
  field("paymentStatus", "select", false),
  field("notes", "longtext", false),
  field("followUpRequired", "boolean", false),
];

/**
 * The example recovery rule of spec 9.6: price objection while the technician still appears to be on site.
 * It ships INACTIVE (a tenant reviews and activates it; being high impact it needs a second person's approval).
 * `conditions` / `actions` hold ids, enum values and codes only; the lost reason is resolved by code at seed time.
 */
export const EXAMPLE_RECOVERY_RULE = {
  ruleKey: "price-objection-on-site",
  name: "Price objection while the technician is still on site",
  description:
    "When a job ends as Not Sold because the price was too high and the technician still appears to be at the location, create an urgent recovery case, notify Lead Operations and recommend a customer call. Never offers a discount.",
  trigger: "job.not_converted",
  priority: 10,
  cooldownMinutes: 60,
  lostReasonCode: "price-too-high",
} as const;
