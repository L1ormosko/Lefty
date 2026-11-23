import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas for the follow-ups API. Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);
const instant = z.coerce.date();

export const FOLLOW_UP_TARGET_TYPES = ["LEAD", "CUSTOMER", "JOB", "RECOVERY_CASE"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
const STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;

/**
 * Offline fields (§8.7, §25.3), accepted by every write a technician may do in the field. `clientEventId` is a
 * client-generated UUID; the server is idempotent per (tenant, employee, clientEventId). `occurredAt` is the device
 * time of the action (a future time is refused by the service).
 */
const offlineFields = {
  clientEventId: z.string().uuid().optional(),
  occurredAt: instant.optional(),
};

export const createFollowUpSchema = z
  .object({
    targetType: z.enum(FOLLOW_UP_TARGET_TYPES),
    targetId: id,
    title: text(200),
    description: text(4000).optional(),
    dueAt: instant,
    priority: z.enum(PRIORITIES).default("NORMAL"),
    /** Defaults to nobody. Assigning to someone other than yourself needs `follow_ups.assign`. */
    assigneeId: id.optional(),
    ...offlineFields,
  })
  .strict();
export type CreateFollowUpInput = z.infer<typeof createFollowUpSchema>;

export const updateFollowUpSchema = z
  .object({
    title: text(200).optional(),
    description: text(4000).nullable().optional(),
    dueAt: instant.optional(),
    priority: z.enum(PRIORITIES).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), "Send at least one field to change.");
export type UpdateFollowUpInput = z.infer<typeof updateFollowUpSchema>;

/** `assigneeId: null` unassigns. */
export const assignFollowUpSchema = z.object({ assigneeId: id.nullable() }).strict();
export type AssignFollowUpInput = z.infer<typeof assignFollowUpSchema>;

/** Start work (IN_PROGRESS), put it back (OPEN) or reopen a finished / cancelled task. DONE and CANCELLED have their own bodies. */
export const changeFollowUpStatusSchema = z.object({ status: z.enum(["OPEN", "IN_PROGRESS"]), ...offlineFields }).strict();
export type ChangeFollowUpStatusInput = z.infer<typeof changeFollowUpStatusSchema>;

export const completeFollowUpSchema = z.object({ note: text(2000).optional(), ...offlineFields }).strict();
export type CompleteFollowUpInput = z.infer<typeof completeFollowUpSchema>;

export const cancelFollowUpSchema = z.object({ reason: text(500), ...offlineFields }).strict();
export type CancelFollowUpInput = z.infer<typeof cancelFollowUpSchema>;

export const listFollowUpsQuerySchema = pageQuerySchema.extend({
  /** A status, or `open` for OPEN + IN_PROGRESS (the work queue). Default: every status. */
  status: z.enum([...STATUSES, "open"]).optional(),
  priority: z.enum(PRIORITIES).optional(),
  targetType: z.enum(FOLLOW_UP_TARGET_TYPES).optional(),
  /** Needs `targetType`: the tasks of ONE lead / customer / job / recovery case. */
  targetId: id.optional(),
  /** Tasks assigned to this employee (`me` = the caller's own employee record). */
  assigneeEmployeeId: z.union([id, z.literal("me")]).optional(),
  /** `true`: open tasks with nobody assigned; `false`: only assigned ones. */
  unassigned: z.enum(["true", "false"]).optional(),
  /** `true`: open tasks whose due time has passed (the overdue queue). */
  overdue: z.enum(["true"]).optional(),
  dueFrom: instant.optional(),
  dueTo: instant.optional(),
  orgUnitId: id.optional(),
});
export type ListFollowUpsQuery = z.infer<typeof listFollowUpsQuerySchema>;

export const followUpIdParams = z.object({ id });
