import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the training API (`/api/v1/training/**`). Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);
const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

/** `YYYY-MM-DD` (a tenant-local calendar date). Kept as a string: services turn it into a `date` column value. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Not a real calendar date");

export const idParams = z.object({ id });

export const TRAINING_ASSIGNMENT_STATUSES = ["ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export const TRAINING_RECORD_STATUSES = ["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "REVOKED"] as const;

// ───────────── Courses ─────────────

/** Same shape as the DB CHECK `training_course_code_format`. */
const code = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, "lower-case letters, digits, . _ -");
const validityDays = z.number().int().min(1).max(36500);

export const createCourseSchema = z
  .object({
    code,
    name: text(200),
    category: text(100).optional(),
    description: text(4000).optional(),
    /** A TRAINING-type certification a verified completion grants (or renews). */
    certificationId: id.optional(),
    /** How long a completion stays valid; omitted = does not expire. */
    validityDays: validityDays.optional(),
  })
  .strict();
export type CreateCourseInput = z.infer<typeof createCourseSchema>;

/** Everything but the code (fixed). `null` clears. Validity changes apply to completions recorded afterwards. */
export const updateCourseSchema = z
  .object({
    name: text(200).optional(),
    category: text(100).nullable().optional(),
    description: text(4000).nullable().optional(),
    certificationId: id.nullable().optional(),
    validityDays: validityDays.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Nothing to change." });
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;

export const archiveCourseSchema = z.object({ reason: text(500).optional() }).strict();
export type ArchiveCourseInput = z.infer<typeof archiveCourseSchema>;

export const listCoursesQuerySchema = pageQuerySchema.extend({
  includeArchived: booleanQuery.default("false"),
  category: text(100).optional(),
  certificationId: id.optional(),
  q: text(100).optional(),
});
export type ListCoursesQuery = z.infer<typeof listCoursesQuerySchema>;

// ───────────── Assignments ─────────────

export const assignTrainingSchema = z
  .object({
    employeeId: id,
    courseId: id,
    /** Tenant-local due date; omitted = no deadline. */
    dueDate: isoDate.optional(),
    note: text(2000).optional(),
  })
  .strict();
export type AssignTrainingInput = z.infer<typeof assignTrainingSchema>;

/** Due date and note of an open assignment. `null` clears. */
export const updateAssignmentSchema = z
  .object({ dueDate: isoDate.nullable().optional(), note: text(2000).nullable().optional() })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: "Nothing to change." });
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;

export const cancelAssignmentSchema = z.object({ reason: text(500) }).strict();
export type CancelAssignmentInput = z.infer<typeof cancelAssignmentSchema>;

export const startAssignmentSchema = z.object({}).strict();

export const listAssignmentsQuerySchema = pageQuerySchema.extend({
  employeeId: id.optional(),
  courseId: id.optional(),
  status: z.enum(TRAINING_ASSIGNMENT_STATUSES).optional(),
  source: z.enum(["MANUAL", "RECOMMENDATION"]).optional(),
  /** Only open assignments whose due date has passed (tenant-local calendar). */
  overdue: booleanQuery.optional(),
});
export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuerySchema>;

// ───────────── Records ─────────────

const sha256 = z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, "64 hex characters");
const contentType = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, "a media type");

/**
 * Evidence is metadata only (no StorageProvider is configured, §28.3): a free reference (certificate number, provider id)
 * and / or the description of a file the company keeps elsewhere. A file is described completely or not at all.
 */
const evidenceSchema = z
  .object({
    reference: text(200).optional(),
    fileName: text(255).optional(),
    contentType: contentType.optional(),
    sizeBytes: z.number().int().min(1).max(104_857_600).optional(),
    checksumSha256: sha256.optional(),
  })
  .strict()
  .refine((value) => (value.fileName === undefined) === (value.contentType === undefined) && (value.fileName === undefined) === (value.sizeBytes === undefined), {
    message: "Describe a file with its name, content type and size together.",
    path: ["fileName"],
  })
  .refine((value) => value.checksumSha256 === undefined || value.fileName !== undefined, { message: "A checksum needs a file.", path: ["checksumSha256"] });

export const recordCompletionSchema = z
  .object({
    employeeId: id,
    courseId: id,
    /** ISO-8601 instant with offset; not in the future. */
    completedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
    evidence: evidenceSchema.optional(),
    notes: text(2000).optional(),
  })
  .strict();
export type RecordCompletionInput = z.infer<typeof recordCompletionSchema>;

export const verifyRecordSchema = z.object({}).strict();
export const decisionReasonSchema = z.object({ reason: text(500) }).strict();
export type DecisionReasonInput = z.infer<typeof decisionReasonSchema>;

export const listRecordsQuerySchema = pageQuerySchema.extend({
  employeeId: id.optional(),
  courseId: id.optional(),
  status: z.enum(TRAINING_RECORD_STATUSES).optional(),
});
export type ListRecordsQuery = z.infer<typeof listRecordsQuerySchema>;

/** Verified completions expiring within `withinDays` (default: the tenant's qualification warning days). */
export const expiringRecordsQuerySchema = pageQuerySchema.extend({
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
  includeExpired: booleanQuery.default("false"),
  employeeId: id.optional(),
  courseId: id.optional(),
});
export type ExpiringRecordsQuery = z.infer<typeof expiringRecordsQuerySchema>;
