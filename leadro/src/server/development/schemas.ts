import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/**
 * Zod schemas of the development API (`/api/v1/development-plans/**`, `/api/v1/training/recommendations/**`). Routes
 * validate with them; services trust the types.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);

/** `YYYY-MM-DD` (a tenant-local calendar date), kept as a string; services turn it into a `date` column value. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Not a real calendar date");

const nothingToChange = { message: "Nothing to change." };
const hasSomeField = (value: Record<string, unknown>) => Object.values(value).some((field) => field !== undefined);

export const idParams = z.object({ id });
export const goalParams = z.object({ id, goalId: id });
export const actionParams = z.object({ id, actionId: id });

export const DEVELOPMENT_PLAN_STATUSES = ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"] as const;
export const DEVELOPMENT_GOAL_STATUSES = ["OPEN", "ACHIEVED", "DROPPED"] as const;
export const DEVELOPMENT_ACTION_KINDS = ["TRAINING", "COACHING", "OTHER"] as const;
export const DEVELOPMENT_ACTION_STATUSES = ["PLANNED", "DONE", "CANCELLED"] as const;
export const TRAINING_RECOMMENDATION_STATUSES = ["OPEN", "ACCEPTED", "DISMISSED"] as const;

// ───────────── Plans ─────────────

export const createPlanSchema = z
  .object({
    employeeId: id,
    title: text(200),
    summary: text(4000).optional(),
    /** Period `[periodStart, periodEnd)`, end exclusive. */
    periodStart: isoDate,
    periodEnd: isoDate,
    /** The accountable person (a user who holds `development_plans.edit` over the employee); defaults to the caller. */
    ownerId: id.optional(),
  })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart, { message: "The period must end after it starts.", path: ["periodEnd"] });
export type CreatePlanInput = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = z
  .object({
    title: text(200).optional(),
    summary: text(4000).nullable().optional(),
    periodStart: isoDate.optional(),
    periodEnd: isoDate.optional(),
    ownerId: id.optional(),
  })
  .strict()
  .refine(hasSomeField, nothingToChange);
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const cancelPlanSchema = z.object({ reason: text(500) }).strict();
export type CancelPlanInput = z.infer<typeof cancelPlanSchema>;

export const emptyBodySchema = z.object({}).strict();

export const listPlansQuerySchema = pageQuerySchema
  .extend({
    employeeId: id.optional(),
    ownerId: id.optional(),
    status: z.enum(DEVELOPMENT_PLAN_STATUSES).optional(),
  })
  .strict();
export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;

// ───────────── Goals ─────────────

export const createGoalSchema = z
  .object({
    title: text(200),
    description: text(4000).optional(),
    targetDate: isoDate.optional(),
    /** A PUBLISHED metric definition the goal is about (development context only; never a threshold). */
    metricDefinitionId: id.optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type CreateGoalInput = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = z
  .object({
    title: text(200).optional(),
    description: text(4000).nullable().optional(),
    targetDate: isoDate.nullable().optional(),
    metricDefinitionId: id.nullable().optional(),
    position: z.number().int().min(0).max(1000).optional(),
    /** OPEN <-> ACHIEVED / DROPPED (a goal can be reopened). */
    status: z.enum(DEVELOPMENT_GOAL_STATUSES).optional(),
  })
  .strict()
  .refine(hasSomeField, nothingToChange);
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

// ───────────── Actions ─────────────

export const createActionSchema = z
  .object({
    kind: z.enum(DEVELOPMENT_ACTION_KINDS),
    description: text(4000),
    goalId: id.optional(),
    dueDate: isoDate.optional(),
    /** Required for TRAINING (an assignment of the plan's employee); not allowed otherwise. */
    trainingAssignmentId: id.optional(),
    /** Optional for COACHING (a coaching record of the plan's employee); not allowed otherwise. */
    coachingRecordId: id.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === "TRAINING") !== (value.trainingAssignmentId !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trainingAssignmentId"], message: "A training action names exactly one training assignment." });
    }
    if (value.coachingRecordId !== undefined && value.kind !== "COACHING") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coachingRecordId"], message: "Only a coaching action names a coaching record." });
    }
  });
export type CreateActionInput = z.infer<typeof createActionSchema>;

/** Text, goal and due date of a PLANNED action, or its outcome (PLANNED -> DONE | CANCELLED, final). */
export const updateActionSchema = z
  .object({
    description: text(4000).optional(),
    goalId: id.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    status: z.enum(["DONE", "CANCELLED"]).optional(),
  })
  .strict()
  .refine(hasSomeField, nothingToChange);
export type UpdateActionInput = z.infer<typeof updateActionSchema>;

// ───────────── Reviews ─────────────

export const createReviewSchema = z.object({ body: text(8000) }).strict();
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

// ───────────── Recommendations ─────────────

export const listRecommendationsQuerySchema = pageQuerySchema
  .extend({
    employeeId: id.optional(),
    courseId: id.optional(),
    status: z.enum(TRAINING_RECOMMENDATION_STATUSES).optional(),
  })
  .strict();
export type ListRecommendationsQuery = z.infer<typeof listRecommendationsQuerySchema>;

/** One employee, or (omitted) every active employee in the caller's `training.assign` scope. */
export const generateRecommendationsSchema = z.object({ employeeId: id.optional() }).strict();
export type GenerateRecommendationsInput = z.infer<typeof generateRecommendationsSchema>;

export const acceptRecommendationSchema = z
  .object({
    /** Of the new assignment: tenant-local, not in the past. */
    dueDate: isoDate.optional(),
    note: text(2000).optional(),
    /** Also add a TRAINING action for the new assignment to this plan (same employee, DRAFT or ACTIVE). */
    planId: id.optional(),
    goalId: id.optional(),
  })
  .strict()
  .refine((value) => value.goalId === undefined || value.planId !== undefined, { message: "A goal needs its plan.", path: ["goalId"] });
export type AcceptRecommendationInput = z.infer<typeof acceptRecommendationSchema>;

export const dismissRecommendationSchema = z.object({ reason: text(500) }).strict();
export type DismissRecommendationInput = z.infer<typeof dismissRecommendationSchema>;

// ───────────── Development thresholds (tenant settings) ─────────────

/** Same shape as the DB CHECK `performance_metric_definition_key_format`. */
const metricKey = z.string().trim().regex(/^[a-z][a-z0-9_]{0,62}$/, "lower-case letters, digits, _");

/**
 * One threshold of the "metric below threshold" rule. `belowMilli` is in thousandths of the value's ratio numerator /
 * denominator (integers only, no floats): 750 = a 75 % rate; for CUSTOMER_FEEDBACK_AVERAGE (sum of 1-5 ratings over their
 * count) 3500 = an average of 3.5. A value is below when numerator x 1000 < belowMilli x denominator.
 */
export const developmentThresholdSchema = z
  .object({
    metricKey,
    belowMilli: z.number().int().min(1).max(5000),
    /** The course recommended when the threshold is not reached. */
    courseId: id,
  })
  .strict();
export type DevelopmentThreshold = z.infer<typeof developmentThresholdSchema>;

/** Replaces the whole list; `[]` switches the rule off. One threshold per metric key. */
export const updateDevelopmentThresholdsSchema = z
  .object({ thresholds: z.array(developmentThresholdSchema).max(50) })
  .strict()
  .refine((value) => new Set(value.thresholds.map((entry) => entry.metricKey)).size === value.thresholds.length, {
    message: "One threshold per metric key.",
    path: ["thresholds"],
  });
export type UpdateDevelopmentThresholdsInput = z.infer<typeof updateDevelopmentThresholdsSchema>;
