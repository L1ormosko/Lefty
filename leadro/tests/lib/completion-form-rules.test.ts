import { describe, expect, it } from "vitest";
import { formFields, formSchemaProblems, missingRequiredFields, type CompletionFacts } from "@/lib/completion-form-rules";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import esUS from "@/lib/i18n/catalogs/es-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import { DEFAULT_FORM_FIELDS_BY_CATEGORY, FALLBACK_FORM_FIELDS } from "../../prisma/seed/field-specs";

const FIELD_DEFAULT_FORM_FIELDS = [...Object.values(DEFAULT_FORM_FIELDS_BY_CATEGORY), FALLBACK_FORM_FIELDS];

const field = (key: string, type: string, required = true) => ({ key, type, required, labelKey: "COMPLETION_FORM.FIELD.X" });
const facts = (overrides: Partial<CompletionFacts> = {}): CompletionFacts => ({
  outcome: null,
  materialCount: 0,
  photoCount: 0,
  hasSignature: false,
  notes: undefined,
  followUpRequired: undefined,
  ...overrides,
});
const sold = { type: "SOLD", quotedAmountMinor: null, approvedAmountMinor: null, chargedAmountMinor: 100, collectedAmountMinor: null, paymentMethod: null };

describe("formSchemaProblems", () => {
  it("accepts a valid schema and reports each kind of problem with its path", () => {
    expect(formSchemaProblems({ fields: [field("outcome", "select"), field("notes", "longtext", false)] })).toEqual([]);
    expect(formSchemaProblems(null)).toEqual([{ path: "", code: "not_an_object" }]);
    expect(formSchemaProblems({})).toEqual([{ path: "fields", code: "fields_missing" }]);
    expect(formSchemaProblems({ fields: [] })).toEqual([{ path: "fields", code: "no_fields" }]);
    expect(formSchemaProblems({ fields: [field("shoeSize", "text")] })).toEqual([{ path: "fields[0].key", code: "unknown_key" }]);
    expect(formSchemaProblems({ fields: [field("outcome", "money")] })).toEqual([{ path: "fields[0].type", code: "type_not_allowed" }]);
    expect(formSchemaProblems({ fields: [field("notes", "text"), field("notes", "text")] })).toEqual([{ path: "fields[1].key", code: "duplicate_key" }]);
    expect(formSchemaProblems({ fields: [{ ...field("notes", "text"), required: "yes" }] })).toEqual([{ path: "fields[0].required", code: "required_not_boolean" }]);
    expect(formSchemaProblems({ fields: [{ ...field("notes", "text"), labelKey: "plain text" }] })).toEqual([{ path: "fields[0].labelKey", code: "label_key_invalid" }]);
  });

  it("accepts every default form the seed ships (they must stay valid against the validator)", () => {
    for (const fields of FIELD_DEFAULT_FORM_FIELDS) expect(formSchemaProblems({ fields })).toEqual([]);
  });
});

describe("missingRequiredFields", () => {
  const form = formFields({ fields: [field("outcome", "select"), field("finalChargedAmount", "money"), field("materials", "materials"), field("photos", "photos"), field("notes", "text"), field("followUpRequired", "boolean", false)] });

  it("lists every required fact that is not there yet, and ignores optional fields", () => {
    expect(missingRequiredFields(form, facts())).toEqual(["outcome", "finalChargedAmount", "materials", "photos", "notes"]);
    expect(missingRequiredFields(form, facts({ outcome: sold, materialCount: 1, photoCount: 2, notes: "done" }))).toEqual([]);
    expect(missingRequiredFields(form, facts({ outcome: sold, materialCount: 1, photoCount: 2, notes: "   " }))).toEqual(["notes"]);
  });

  it("does not demand money or materials of a visit that did not sell, but still demands photos and notes", () => {
    expect(missingRequiredFields(form, facts({ outcome: { ...sold, type: "NOT_SOLD", chargedAmountMinor: null } }))).toEqual(["photos", "notes"]);
  });
});

describe("catalog labels for the seeded forms", () => {
  it("every default form field has a label in all three catalogs", () => {
    const keys = FIELD_DEFAULT_FORM_FIELDS.flat().map((entry) => entry.labelKey);
    for (const messages of [enUS.messages, esUS.messages, heIL.messages] as Array<Record<string, string>>) {
      expect(keys.filter((key) => !messages[key])).toEqual([]);
    }
  });
});
