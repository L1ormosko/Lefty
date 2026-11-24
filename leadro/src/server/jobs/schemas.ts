import { z } from "zod";
import { isValidTimeZone } from "@/lib/i18n";
import { JOB_STATUSES } from "@/lib/job-lifecycle";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the jobs API. Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);
const reason = text(500);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const timeZone = z.string().trim().min(1).max(64).refine(isValidTimeZone, "Not a known IANA time zone");
const priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "ISO 4217 code");
const duration = z.number().int().min(5).max(24 * 60);
const money = z.number().int().min(0).max(2_000_000_000);

const span = z
  .object({ start: instant, end: instant })
  .strict()
  .refine((value) => value.end > value.start, { path: ["end"], message: "The end must be after the start" });

export const jobIdParams = z.object({ id });

const additionalRequirements = z
  .object({
    skills: z.array(z.object({ skillId: id, minLevel: z.number().int().min(1).max(5).nullish() }).strict()).max(20).default([]),
    certificationIds: z.array(id).max(20).default([]),
  })
  .strict();

/** Manual job creation. `LEAD_CONVERSION` is only created by the leads module; agreements and integrations arrive with their modules. */
export const createJobSchema = z
  .object({
    customerId: id,
    serviceAddressId: id,
    jobTypeId: id,
    /** Defaults to the service address's unit, then the customer's. Must lie inside the customer's own unit. */
    orgUnitId: id.optional(),
    origin: z.enum(["MANUAL", "CUSTOMER_FOLLOW_UP"]).default("MANUAL"),
    /** The job this one follows up (same customer). */
    parentJobId: id.optional(),
    title: text(200).optional(),
    description: text(4000).optional(),
    instructions: text(4000).optional(),
    priority: priority.optional(),
    appointmentWindow: span.optional(),
    estimatedDurationMinutes: duration.optional(),
    timeZone: timeZone.optional(),
    quotedAmountMinor: money.optional(),
    currency: currency.optional(),
    /** §25.2 "requires additional qualification": on top of the job type's own requirements. */
    additionalRequirements: additionalRequirements.optional(),
  })
  .strict();
export type CreateJobInput = z.infer<typeof createJobSchema>;

/** Editable job facts. Scheduling has its own endpoint, status and assignment too. */
export const updateJobSchema = z
  .object({
    title: text(200),
    description: text(4000).nullable(),
    instructions: text(4000).nullable(),
    priority,
    estimatedDurationMinutes: duration,
    timeZone: timeZone.nullable(),
    quotedAmountMinor: money.nullable(),
    currency,
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

/**
 * `clientEventId` + `occurredAt` are the offline envelope (§8.7) and exist for the technician's EN_ROUTE move only
 * (the one status change a device queues without a position check): the service refuses them for any other target.
 */
export const transitionJobSchema = z
  .object({
    toStatus: z.enum(JOB_STATUSES),
    reason: reason.optional(),
    clientEventId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
    occurredAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
  })
  .strict();
export type TransitionJobInput = z.infer<typeof transitionJobSchema>;

/** Give the job to ONE employee or ONE team; replaces the current assignment (reassignment). */
export const assignJobSchema = z
  .object({
    employeeId: id.optional(),
    teamOrgUnitId: id.optional(),
    reason: reason.optional(),
    /**
     * Optimistic precondition: the id of the ACTIVE assignment the caller saw (`null` = it saw none). A different current
     * assignment answers 409 instead of silently replacing a colleague's decision. Omit to skip the check.
     */
    expectedAssignmentId: id.nullable().optional(),
    /** Assign although the hard eligibility check failed. Needs `jobs.approve`; the reason is recorded. */
    override: z.object({ reason }).strict().optional(),
  })
  .strict()
  .refine((value) => (value.employeeId === undefined) !== (value.teamOrgUnitId === undefined), {
    path: ["employeeId"],
    message: "Give exactly one of employeeId or teamOrgUnitId",
  });
export type AssignJobInput = z.infer<typeof assignJobSchema>;

export const unassignJobSchema = z.object({ reason }).strict();
export type UnassignJobInput = z.infer<typeof unassignJobSchema>;

/** At least one of the two spans; `scheduledSlot: null` clears the slot. */
export const rescheduleJobSchema = z
  .object({
    appointmentWindow: span.nullable().optional(),
    scheduledSlot: span.nullable().optional(),
    reason: reason.optional(),
  })
  .strict()
  .refine((value) => value.appointmentWindow !== undefined || value.scheduledSlot !== undefined, "Give an appointment window or a scheduled slot");
export type RescheduleJobInput = z.infer<typeof rescheduleJobSchema>;

const statusList = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim()).filter(Boolean))
  .pipe(z.array(z.enum(JOB_STATUSES)).min(1).max(JOB_STATUSES.length));

const booleanText = z.enum(["true", "false"]).transform((value) => value === "true");

export const listJobsQuerySchema = pageQuerySchema.extend({
  /** Comma-separated statuses, e.g. `PENDING_ASSIGNMENT,ASSIGNED`. */
  status: statusList.optional(),
  priority: priority.optional(),
  orgUnitId: id.optional(),
  customerId: id.optional(),
  jobTypeId: id.optional(),
  /** Jobs assigned to this employee, directly or through a team. */
  assignedEmployeeId: id.optional(),
  /** "true": jobs with no active assignment. */
  unassigned: booleanText.optional(),
  scheduledFrom: instant.optional(),
  scheduledTo: instant.optional(),
  /** Title substring, or `#number`. */
  q: text(100).optional(),
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
});
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

/** "My jobs": the caller's own assignments. Closed and cancelled work is hidden unless a `status` filter names it. */
export const listMyJobsQuerySchema = pageQuerySchema.extend({
  status: statusList.optional(),
  scheduledFrom: instant.optional(),
  scheduledTo: instant.optional(),
});
export type ListMyJobsQuery = z.infer<typeof listMyJobsQuerySchema>;

export const listHistoryQuerySchema = pageQuerySchema;
export type ListHistoryQuery = z.infer<typeof listHistoryQuerySchema>;

export const updateWorkflowSettingsSchema = z
  .object({ disabledTransitions: z.array(z.string().trim().min(1).max(80)).max(200) })
  .strict();
export type UpdateWorkflowSettingsInput = z.infer<typeof updateWorkflowSettingsSchema>;
