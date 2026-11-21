import { z } from "zod";
import { SUPPORTED_LOCALES, isValidTimeZone } from "@/lib/i18n";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas for the organization API. Routes validate with them; services trust the types. */

const name = z.string().trim().min(1).max(120);
const optionalText = (max: number) => z.string().trim().min(1).max(max);
export const idSchema = z.string().trim().min(1).max(64);
export const timeZoneSchema = z.string().max(64).refine(isValidTimeZone, "Unknown IANA time zone");
export const localeSchema = z.enum(SUPPORTED_LOCALES);

/** US-style postal address of a branch. Stored as JSON; strict so stray keys are rejected. */
export const addressSchema = z
  .object({
    line1: optionalText(200),
    line2: optionalText(200).optional(),
    city: optionalText(100),
    state: z.string().trim().length(2).toUpperCase(),
    postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Expected a US ZIP code"),
    country: z.literal("US").default("US"),
  })
  .strict();

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
/** Opening hours per weekday; a missing day or `null` means closed. Times are branch-local. */
export const operatingHoursSchema = z.record(weekday, z.object({ open: clock, close: clock }).strict().nullable());

export const orgUnitTypeSchema = z.enum(["BUSINESS_UNIT", "STATE", "REGION", "CITY", "BRANCH", "DEPARTMENT", "TEAM"]);

/** Attributes that only make sense for a BRANCH; the service rejects them on other types. */
const branchAttributes = {
  address: addressSchema.optional(),
  timeZone: timeZoneSchema.optional(),
  defaultLocale: localeSchema.optional(),
  operatingHours: operatingHoursSchema.optional(),
};

export const createOrgUnitSchema = z
  .object({
    type: orgUnitTypeSchema,
    name,
    code: optionalText(40).optional(),
    /** Omit (or null) for a top-level unit. */
    parentId: idSchema.nullish(),
    legalEntityId: idSchema.nullish(),
    ...branchAttributes,
  })
  .strict();
export type CreateOrgUnitInput = z.infer<typeof createOrgUnitSchema>;

/** The type of a unit never changes; to "change" it, create a new unit and move the people. */
export const updateOrgUnitSchema = z
  .object({
    name: name.optional(),
    code: optionalText(40).nullish(),
    legalEntityId: idSchema.nullish(),
    address: addressSchema.nullish(),
    timeZone: timeZoneSchema.nullish(),
    defaultLocale: localeSchema.nullish(),
    operatingHours: operatingHoursSchema.nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateOrgUnitInput = z.infer<typeof updateOrgUnitSchema>;

export const moveOrgUnitSchema = z.object({ newParentId: idSchema.nullable(), reason: optionalText(500).optional() }).strict();
export type MoveOrgUnitInput = z.infer<typeof moveOrgUnitSchema>;

export const archiveSchema = z.object({ reason: optionalText(500).optional() }).strict();
export type ArchiveInput = z.infer<typeof archiveSchema>;

export const listOrgUnitsQuerySchema = pageQuerySchema.extend({
  parentId: idSchema.optional(),
  type: orgUnitTypeSchema.optional(),
  /** `true` (default) = only active units, `false` = only archived, `all` = both. */
  active: z.enum(["true", "false", "all"]).default("true"),
  search: z.string().trim().min(1).max(100).optional(),
});
export type ListOrgUnitsQuery = z.infer<typeof listOrgUnitsQuerySchema>;

export const createLegalEntitySchema = z
  .object({ name, legalName: optionalText(200).optional() })
  .strict();
export type CreateLegalEntityInput = z.infer<typeof createLegalEntitySchema>;

export const updateLegalEntitySchema = z
  .object({ name: name.optional(), legalName: optionalText(200).nullish() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateLegalEntityInput = z.infer<typeof updateLegalEntitySchema>;

export const listLegalEntitiesQuerySchema = pageQuerySchema.extend({
  active: z.enum(["true", "false", "all"]).default("true"),
});
export type ListLegalEntitiesQuery = z.infer<typeof listLegalEntitiesQuerySchema>;

export const assignManagerSchema = z
  .object({ employeeId: idSchema, isPrimary: z.boolean().default(false) })
  .strict();
export type AssignManagerInput = z.infer<typeof assignManagerSchema>;

export const updateTenantProfileSchema = z
  .object({ name: name.optional(), defaultLocale: localeSchema.optional(), defaultTimeZone: timeZoneSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateTenantProfileInput = z.infer<typeof updateTenantProfileSchema>;

export const listManagersQuerySchema = pageQuerySchema.extend({
  /** Include assignments that already ended (history). Default: current managers only. */
  includeEnded: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});
export type ListManagersQuery = z.infer<typeof listManagersQuerySchema>;
