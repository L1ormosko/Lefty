/**
 * Completion forms (§8.6), pure rules. A form DEFINITION lists which fields a job type asks for at the end of a visit;
 * a SUBMISSION is checked against the definition version it was filled in with. Nothing here touches the database.
 *
 * Where the answers live (`docs/ERD.md` "Contracts for JSON"): the form only says which facts must exist. Money and the
 * payment record are the visit's `JobOutcome`, materials are `JobMaterialUsage` rows, photos and the signature are
 * `JobAttachment` rows; only `notes` and `followUpRequired` are answered in the submission itself. So checking a form
 * means looking at those facts (`CompletionFacts`) and reporting what is still missing.
 */

/** The closed vocabulary of field keys (§8.6 "potential fields"). */
export const COMPLETION_FIELD_KEYS = [
  "outcome",
  "quotedAmount",
  "approvedAmount",
  "finalChargedAmount",
  "amountCollected",
  "paymentMethod",
  "paymentStatus",
  "materials",
  "photos",
  "notes",
  "customerSignature",
  "followUpRequired",
] as const;
export type CompletionFieldKey = (typeof COMPLETION_FIELD_KEYS)[number];

export const COMPLETION_FIELD_TYPES = ["select", "money", "text", "longtext", "boolean", "materials", "photos", "signature"] as const;
export type CompletionFieldType = (typeof COMPLETION_FIELD_TYPES)[number];

/** Which input types a key may use (the UI renders by type, the server stores by key). */
const ALLOWED_TYPES: Record<CompletionFieldKey, readonly CompletionFieldType[]> = {
  outcome: ["select"],
  quotedAmount: ["money"],
  approvedAmount: ["money"],
  finalChargedAmount: ["money"],
  amountCollected: ["money"],
  paymentMethod: ["select"],
  paymentStatus: ["select"],
  materials: ["materials"],
  photos: ["photos"],
  notes: ["text", "longtext"],
  customerSignature: ["signature"],
  followUpRequired: ["boolean"],
};

export interface CompletionField {
  key: CompletionFieldKey;
  type: CompletionFieldType;
  required: boolean;
  /** i18n key of the label (never text). */
  labelKey: string;
}

export interface FormSchemaProblem {
  /** Path inside the schema, e.g. `fields[2].type`. */
  path: string;
  code: "not_an_object" | "fields_missing" | "unknown_key" | "duplicate_key" | "type_not_allowed" | "required_not_boolean" | "label_key_invalid" | "no_fields";
}

const LABEL_KEY = /^[A-Z][A-Z0-9_]*(\.[A-Z0-9_]+)+$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks the stored schema's shape beyond the database's outer-shape CHECK. Empty result = valid. */
export function formSchemaProblems(schema: unknown): FormSchemaProblem[] {
  if (!isRecord(schema)) return [{ path: "", code: "not_an_object" }];
  if (!Array.isArray(schema.fields)) return [{ path: "fields", code: "fields_missing" }];
  if (schema.fields.length === 0) return [{ path: "fields", code: "no_fields" }];
  const problems: FormSchemaProblem[] = [];
  const seen = new Set<string>();
  schema.fields.forEach((entry: unknown, index: number) => {
    const at = `fields[${index}]`;
    if (!isRecord(entry)) return void problems.push({ path: at, code: "not_an_object" });
    const key = entry.key as CompletionFieldKey;
    if (!COMPLETION_FIELD_KEYS.includes(key)) return void problems.push({ path: `${at}.key`, code: "unknown_key" });
    if (seen.has(key)) problems.push({ path: `${at}.key`, code: "duplicate_key" });
    seen.add(key);
    if (!ALLOWED_TYPES[key].includes(entry.type as CompletionFieldType)) problems.push({ path: `${at}.type`, code: "type_not_allowed" });
    if (typeof entry.required !== "boolean") problems.push({ path: `${at}.required`, code: "required_not_boolean" });
    if (typeof entry.labelKey !== "string" || !LABEL_KEY.test(entry.labelKey)) problems.push({ path: `${at}.labelKey`, code: "label_key_invalid" });
  });
  return problems;
}

/** The fields of a VALID schema (call `formSchemaProblems` first). */
export const formFields = (schema: unknown): CompletionField[] => ((schema as { fields: CompletionField[] }).fields ?? []).map((entry) => ({ ...entry }));

/** What exists for the visit being completed. `outcome` is null until the visit's outcome was reported. */
export interface CompletionFacts {
  outcome: {
    type: string;
    quotedAmountMinor: number | null;
    approvedAmountMinor: number | null;
    chargedAmountMinor: number | null;
    collectedAmountMinor: number | null;
    paymentMethod: string | null;
  } | null;
  materialCount: number;
  photoCount: number;
  /** The submission carries a signature attachment. */
  hasSignature: boolean;
  /** The submission's own answers. */
  notes: string | undefined;
  followUpRequired: boolean | undefined;
}

/**
 * Keys that only make sense for a visit that was sold: asking for a charged amount or a signature after "customer not
 * home" would make the form impossible to complete. The outcome itself, photos, notes and the follow-up answer are
 * always enforced.
 */
const SOLD_ONLY_KEYS: readonly CompletionFieldKey[] = [
  "approvedAmount",
  "finalChargedAmount",
  "amountCollected",
  "paymentMethod",
  "paymentStatus",
  "materials",
  "customerSignature",
];

function isSatisfied(key: CompletionFieldKey, facts: CompletionFacts): boolean {
  const { outcome } = facts;
  switch (key) {
    case "outcome":
    case "paymentStatus": // always has a value once the outcome exists (default NOT_APPLICABLE)
      return outcome !== null;
    case "quotedAmount":
      return outcome?.quotedAmountMinor != null;
    case "approvedAmount":
      return outcome?.approvedAmountMinor != null;
    case "finalChargedAmount":
      return outcome?.chargedAmountMinor != null;
    case "amountCollected":
      return outcome?.collectedAmountMinor != null;
    case "paymentMethod":
      return outcome?.paymentMethod != null;
    case "materials":
      return facts.materialCount > 0;
    case "photos":
      return facts.photoCount > 0;
    case "notes":
      return (facts.notes?.trim().length ?? 0) > 0;
    case "customerSignature":
      return facts.hasSignature;
    case "followUpRequired":
      return facts.followUpRequired !== undefined;
  }
}

/** The required fields that are still missing (an empty list means the form may be submitted). */
export function missingRequiredFields(fields: readonly CompletionField[], facts: CompletionFacts): CompletionFieldKey[] {
  const sold = facts.outcome?.type === "SOLD";
  return fields
    .filter((field) => field.required)
    .filter((field) => (SOLD_ONLY_KEYS.includes(field.key) ? sold || facts.outcome === null : true))
    .filter((field) => !isSatisfied(field.key, facts))
    .map((field) => field.key);
}
