import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the customer feedback API (`/api/v1/customer-feedback/**`). Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const flag = z.enum(["true", "false"]).transform((value) => value === "true");

export const FEEDBACK_COMMENT_MAX = 4000;
export const FEEDBACK_VOID_REASON_MAX = 1000;

/**
 * Customer Relations records what a customer said about one job, by hand (the channel is always MANUAL: there is no survey
 * provider). A rating (1-5), a comment, or both. `employeeId` names the person the feedback is about (someone who was
 * assigned to the job); omitted = about the job or the company, counted for nobody.
 */
export const recordFeedbackSchema = z
  .object({
    jobId: id,
    employeeId: id.optional(),
    rating: z.number().int().min(1).max(5).optional(),
    comment: text(FEEDBACK_COMMENT_MAX).optional(),
    /** When the customer gave the feedback (default: now). Never in the future. */
    receivedAt: instant.optional(),
  })
  .strict()
  .refine((value) => value.rating !== undefined || value.comment !== undefined, {
    message: "Give a rating, a comment or both.",
    path: ["rating"],
  });
export type RecordFeedbackInput = z.infer<typeof recordFeedbackSchema>;

export const voidFeedbackSchema = z.object({ reason: text(FEEDBACK_VOID_REASON_MAX) }).strict();
export type VoidFeedbackInput = z.infer<typeof voidFeedbackSchema>;

export const listFeedbackQuerySchema = pageQuerySchema
  .extend({
    jobId: id.optional(),
    customerId: id.optional(),
    employeeId: id.optional(),
    /** Voided entries are hidden unless `includeVoided=true`. */
    includeVoided: flag.optional(),
  })
  .strict();
export type ListFeedbackQuery = z.infer<typeof listFeedbackQuerySchema>;
