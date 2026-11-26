import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the coaching API (coaching records and metric context notes). Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);
const flag = z.enum(["true", "false"]).transform((value) => value === "true");

/** An ISO-8601 instant with an explicit offset (`2026-11-21T13:40:00Z`). */
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

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

/** Coaching notes and context notes are a few paragraphs at most. */
export const NOTE_BODY_MAX = 8000;

export const createCoachingRecordSchema = z
  .object({
    employeeId: id,
    body: text(NOTE_BODY_MAX),
    /** When the conversation took place; defaults to now. Never in the future. */
    occurredAt: instant.optional(),
    /** The metric value the note is about (must be the same employee's). */
    metricValueId: id.optional(),
    /** Share with the employee right away (default: private, spec 10.4). */
    shareWithEmployee: z.boolean().optional(),
  })
  .strict();
export type CreateCoachingRecordInput = z.infer<typeof createCoachingRecordSchema>;

/** Text and time of a PRIVATE note, by its author. A shared note changes only through an upheld data challenge. */
export const updateCoachingRecordSchema = z
  .object({ body: text(NOTE_BODY_MAX).optional(), occurredAt: instant.optional() })
  .strict()
  .refine((value) => value.body !== undefined || value.occurredAt !== undefined, { message: "Nothing to change" });
export type UpdateCoachingRecordInput = z.infer<typeof updateCoachingRecordSchema>;

export const listCoachingRecordsQuerySchema = pageQuerySchema
  .extend({
    employeeId: id.optional(),
    authorId: id.optional(),
    metricValueId: id.optional(),
    shared: flag.optional(),
    includeArchived: flag.optional(),
  })
  .strict();
export type ListCoachingRecordsQuery = z.infer<typeof listCoachingRecordsQuerySchema>;

/**
 * A context note is about ONE metric value (`metricValueId`; the employee comes from the value) or about a period of one
 * employee (`employeeId` + `periodStart` + `periodEnd`, end exclusive). Never both.
 */
export const createContextNoteSchema = z
  .object({
    metricValueId: id.optional(),
    employeeId: id.optional(),
    periodStart: dateOnly.optional(),
    periodEnd: dateOnly.optional(),
    body: text(NOTE_BODY_MAX),
    shareWithEmployee: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPeriod = value.periodStart !== undefined || value.periodEnd !== undefined;
    if (value.metricValueId !== undefined) {
      if (hasPeriod) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["periodStart"], message: "A note about a value takes the value's period" });
      return;
    }
    if (value.employeeId === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["employeeId"], message: "Required without metricValueId" });
    if (value.periodStart === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["periodStart"], message: "Required without metricValueId" });
    if (value.periodEnd === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["periodEnd"], message: "Required without metricValueId" });
    if (value.periodStart && value.periodEnd && value.periodEnd <= value.periodStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["periodEnd"], message: "Must be after the period start" });
    }
  });
export type CreateContextNoteInput = z.infer<typeof createContextNoteSchema>;

export const listContextNotesQuerySchema = pageQuerySchema
  .extend({ employeeId: id.optional(), metricValueId: id.optional(), includeArchived: flag.optional() })
  .strict();
export type ListContextNotesQuery = z.infer<typeof listContextNotesQuerySchema>;
