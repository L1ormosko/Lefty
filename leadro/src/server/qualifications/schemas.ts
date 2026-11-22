import { z } from "zod";
import { isValidTimeZone } from "@/lib/i18n";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the qualifications API. Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);

/** `YYYY-MM-DD` -> a Date at 00:00 UTC (what a Postgres `date` column stores). Rejects 2026-02-31. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .transform((value, ctx) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a real calendar date" });
      return z.NEVER;
    }
    return date;
  });

/** An ISO-8601 instant with an explicit offset (`2026-11-21T13:40:00Z`). */
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

const timeZone = z.string().trim().min(1).max(64).refine(isValidTimeZone, "Not a known IANA time zone");

const codeFormat = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "Lower-case letters, digits, - and _ (max 63)");

/** Credential types a catalog row may have (a skill is its own catalog). */
export const CREDENTIAL_TYPES = ["CERTIFICATION", "LICENSE", "EQUIPMENT", "TRAINING"] as const;

// ───────────────────────── Catalogs ─────────────────────────

export const listCatalogQuerySchema = pageQuerySchema.extend({
  active: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});
export type ListCatalogQuery = z.infer<typeof listCatalogQuerySchema>;

export const listCertificationsQuerySchema = listCatalogQuerySchema.extend({ type: z.enum(CREDENTIAL_TYPES).optional() });
export type ListCertificationsQuery = z.infer<typeof listCertificationsQuerySchema>;

export const createSkillSchema = z
  .object({
    code: codeFormat,
    name: text(120),
    category: text(80).nullish(),
    description: text(1000).nullish(),
  })
  .strict();
export type CreateSkillInput = z.infer<typeof createSkillSchema>;

export const updateSkillSchema = z
  .object({
    name: text(120).optional(),
    category: text(80).nullish(),
    description: text(1000).nullish(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;

export const createCertificationSchema = z
  .object({
    code: codeFormat,
    name: text(160),
    type: z.enum(CREDENTIAL_TYPES).default("CERTIFICATION"),
    issuingAuthority: text(160).nullish(),
    validityMonths: z.number().int().min(1).max(600).nullish(),
    requiresNumber: z.boolean().default(false),
    description: text(1000).nullish(),
  })
  .strict();
export type CreateCertificationInput = z.infer<typeof createCertificationSchema>;

/** `type` and `code` are fixed once employees hold the credential (history must keep its meaning). */
export const updateCertificationSchema = z
  .object({
    name: text(160).optional(),
    issuingAuthority: text(160).nullish(),
    validityMonths: z.number().int().min(1).max(600).nullish(),
    requiresNumber: z.boolean().optional(),
    description: text(1000).nullish(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateCertificationInput = z.infer<typeof updateCertificationSchema>;

// ───────────────────────── Employee qualifications ─────────────────────────

export const createQualificationSchema = z
  .object({
    employeeId: id,
    /** Exactly one of skillId / certificationId. */
    skillId: id.optional(),
    certificationId: id.optional(),
    /** Proficiency 1-5, skills only. */
    level: z.number().int().min(1).max(5).optional(),
    number: text(80).optional(),
    issuingAuthority: text(160).optional(),
    issuedAt: dateOnly.optional(),
    expiresAt: dateOnly.optional(),
    notes: text(1000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.skillId === undefined) === (value.certificationId === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skillId"], message: "Give exactly one of skillId and certificationId" });
    }
    if (value.skillId === undefined && value.level !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["level"], message: "Only skills have a level" });
    }
    if (value.issuedAt && value.expiresAt && value.expiresAt <= value.issuedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "Must be after the issue date" });
    }
  });
export type CreateQualificationInput = z.infer<typeof createQualificationSchema>;

export const updateQualificationSchema = z
  .object({
    level: z.number().int().min(1).max(5).nullish(),
    number: text(80).nullish(),
    issuingAuthority: text(160).nullish(),
    issuedAt: dateOnly.nullish(),
    expiresAt: dateOnly.nullish(),
    notes: text(1000).nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateQualificationInput = z.infer<typeof updateQualificationSchema>;

export const decisionReasonSchema = z.object({ reason: text(500) }).strict();
export type DecisionReasonInput = z.infer<typeof decisionReasonSchema>;

export const listQualificationsQuerySchema = pageQuerySchema.extend({
  employeeId: id.optional(),
  kind: z.enum(["SKILL", ...CREDENTIAL_TYPES]).optional(),
  status: z.enum(["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "REVOKED"]).optional(),
  skillId: id.optional(),
  certificationId: id.optional(),
});
export type ListQualificationsQuery = z.infer<typeof listQualificationsQuerySchema>;

export const expiringQualificationsQuerySchema = pageQuerySchema.extend({
  /** Defaults to the tenant's `qualificationWarningDays`. */
  withinDays: z.coerce.number().int().min(1).max(730).optional(),
  /** Also list credentials that have already expired (still VERIFIED rows past their date). */
  includeExpired: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});
export type ExpiringQualificationsQuery = z.infer<typeof expiringQualificationsQuerySchema>;

// ───────────────────────── Territories, job permissions, availability ─────────────────────────

export const createTerritorySchema = z
  .object({
    employeeId: id,
    orgUnitId: id,
    includeDescendants: z.boolean().default(true),
    effectiveFrom: instant.optional(),
  })
  .strict();
export type CreateTerritoryInput = z.infer<typeof createTerritorySchema>;

export const listByEmployeeQuerySchema = pageQuerySchema.extend({
  employeeId: id,
  /** true = only rows in force now. */
  activeOnly: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});
export type ListByEmployeeQuery = z.infer<typeof listByEmployeeQuerySchema>;

export const endGrantSchema = z.object({ reason: text(500).optional() }).strict();
export type EndGrantInput = z.infer<typeof endGrantSchema>;

export const createJobPermissionSchema = z
  .object({
    employeeId: id,
    /** Exactly one of jobTypeId / category. */
    jobTypeId: id.optional(),
    category: text(80).optional(),
    effectiveFrom: instant.optional(),
    effectiveTo: instant.optional(),
    reason: text(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.jobTypeId === undefined) === (value.category === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["jobTypeId"], message: "Give exactly one of jobTypeId and category" });
    }
    if (value.effectiveFrom && value.effectiveTo && value.effectiveTo <= value.effectiveFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "Must be after effectiveFrom" });
    }
  });
export type CreateJobPermissionInput = z.infer<typeof createJobPermissionSchema>;

/**
 * Weekly windows cannot cross midnight (schema CHECK): `endMinute` > `startMinute`, 1..1440. A night
 * shift is two windows (Mon 22:00-24:00 = 1320-1440, Tue 00:00-06:00 = 0-360).
 */
const weeklyWindowSchema = z.object({
  kind: z.literal("WEEKLY_WINDOW"),
  employeeId: id,
  isoDayOfWeek: z.number().int().min(1).max(7),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  validFrom: dateOnly.optional(),
  validTo: dateOnly.optional(),
  /** IANA zone the window is read in; default: the employee's (their login's, else branch, else company's). */
  timeZone: timeZone.optional(),
  note: text(300).optional(),
});

const exceptionSchema = z.object({
  kind: z.enum(["EXCEPTION_AVAILABLE", "EXCEPTION_UNAVAILABLE"]),
  employeeId: id,
  startsAt: instant,
  endsAt: instant,
  timeZone: timeZone.optional(),
  note: text(300).optional(),
});

export const createAvailabilitySchema = z
  .discriminatedUnion("kind", [weeklyWindowSchema.strict(), exceptionSchema.strict()])
  .superRefine((value, ctx) => {
    if (value.kind === "WEEKLY_WINDOW") {
      if (value.endMinute <= value.startMinute) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endMinute"], message: "A window cannot cross midnight: end must be after start (split night shifts in two)" });
      }
      if (value.validFrom && value.validTo && value.validTo < value.validFrom) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validTo"], message: "Must not be before validFrom" });
      }
    } else if (value.endsAt <= value.startsAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "Must be after startsAt" });
    }
  });
export type CreateAvailabilityInput = z.infer<typeof createAvailabilitySchema>;

// ───────────────────────── Eligibility check ─────────────────────────

export const eligibilityCheckSchema = z
  .object({
    employeeId: id,
    /** Requirements come from the job type (its skills, credentials, category) plus the extras below. */
    jobTypeId: id,
    /** The job's service-area org unit (territory check). Omit to skip the territory rule. */
    orgUnitId: id.optional(),
    /** Extra requirements on top of the job type's ("requires additional qualification", §25.2). */
    extraSkills: z.array(z.object({ skillId: id, minLevel: z.number().int().min(1).max(5).nullish() }).strict()).max(50).default([]),
    extraCertificationIds: z.array(id).max(50).default([]),
    /** The span to work: appointment window or scheduled slot. Omit to skip the availability rule. */
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    /** Zone for credential expiry dates; default the org unit's, else the company's. */
    timeZone: timeZone.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.startsAt === undefined) !== (value.endsAt === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "Give both startsAt and endsAt, or neither" });
    } else if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "Must be after startsAt" });
    }
  });
export type EligibilityCheckInput = z.infer<typeof eligibilityCheckSchema>;
