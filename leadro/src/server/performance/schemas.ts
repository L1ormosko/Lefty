import { z } from "zod";
import { METRIC_KINDS, MAX_PERIOD_DAYS, periodLengthDays } from "@/lib/performance-formulas";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the performance API (`/api/v1/performance/**`). Kind-specific `params` are checked by the service. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD").refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "not a real date");

export const definitionIdParams = z.object({ id });
export const valueIdParams = z.object({ id });
export const employeeIdParams = z.object({ employeeId: id });

export const DEFINITION_STATUSES = ["DRAFT", "PENDING_APPROVAL", "PUBLISHED", "RETIRED"] as const;

/** Same as the DB CHECK `performance_metric_definition_key_format`. */
const key = z.string().trim().regex(/^[a-z][a-z0-9_]{0,62}$/, "lower-case letters, digits and _ (starting with a letter)");

/** A flat object of kind parameters (validated per kind by `normalizeMetricParams`). */
const params = z.record(z.string().max(40), z.unknown()).refine((value) => Object.keys(value).length <= 10, "at most 10 parameters");
const minSample = z.number().int().min(1).max(10_000);

export const createDefinitionSchema = z
  .object({
    key,
    kind: z.enum(METRIC_KINDS),
    name: text(120),
    description: text(2000).optional(),
    params: params.default({}),
    minSample,
  })
  .strict();
export type CreateDefinitionInput = z.infer<typeof createDefinitionSchema>;

/** A new DRAFT version of an existing key: the kind is kept; anything not given is copied from the source version. */
export const createVersionSchema = z
  .object({
    name: text(120).optional(),
    description: text(2000).nullable().optional(),
    params: params.optional(),
    minSample: minSample.optional(),
  })
  .strict();
export type CreateVersionInput = z.infer<typeof createVersionSchema>;

/** Edits a DRAFT version (the kind of a key never changes; a different kind is a different key). `null` clears. */
export const updateDefinitionSchema = createVersionSchema.refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Nothing to change." });
export type UpdateDefinitionInput = z.infer<typeof updateDefinitionSchema>;

export const submitDefinitionSchema = z.object({ reason: text(500).optional() }).strict();
export type SubmitDefinitionInput = z.infer<typeof submitDefinitionSchema>;

export const reasonSchema = z.object({ reason: text(500) }).strict();
export type ReasonInput = z.infer<typeof reasonSchema>;

export const listDefinitionsQuerySchema = pageQuerySchema.extend({
  status: z.enum(DEFINITION_STATUSES).optional(),
  key: key.optional(),
  kind: z.enum(METRIC_KINDS).optional(),
});
export type ListDefinitionsQuery = z.infer<typeof listDefinitionsQuerySchema>;

/**
 * Computing a definition for a tenant-local period `[periodStart, periodEnd)` (at most MAX_PERIOD_DAYS long): the listed
 * employees, or (omitted) every non-terminated employee in the caller's scope.
 */
export const computeValuesSchema = z
  .object({ periodStart: isoDate, periodEnd: isoDate, employeeIds: z.array(id).min(1).max(200).optional() })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart, { message: "periodEnd must be after periodStart.", path: ["periodEnd"] })
  .refine((value) => periodLengthDays(value.periodStart, value.periodEnd) <= MAX_PERIOD_DAYS, { message: `A period is at most ${MAX_PERIOD_DAYS} days.`, path: ["periodEnd"] });
export type ComputeValuesInput = z.infer<typeof computeValuesSchema>;

const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

/** Every stored snapshot (history), newest first. */
export const listValuesQuerySchema = pageQuerySchema.extend({
  employeeId: id.optional(),
  definitionId: id.optional(),
  key: key.optional(),
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  jobTypeId: id.optional(),
  jobCategory: text(100).optional(),
});
export type ListValuesQuery = z.infer<typeof listValuesQuerySchema>;

/** The current value (newest snapshot) per definition, period and breakdown for one employee. */
export const employeeValuesQuerySchema = z
  .object({
    definitionId: id.optional(),
    key: key.optional(),
    /** Only periods starting on or after / ending on or before these dates. */
    from: isoDate.optional(),
    to: isoDate.optional(),
    enoughDataOnly: booleanQuery.default("false"),
  })
  .strict();
export type EmployeeValuesQuery = z.infer<typeof employeeValuesQuerySchema>;
