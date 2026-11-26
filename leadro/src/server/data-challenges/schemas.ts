import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the data challenges API. Routes validate with them; services trust the types. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);

export const DATA_CHALLENGE_TARGET_TYPES = ["PERFORMANCE_METRIC_VALUE", "TRAINING_RECORD", "COACHING_RECORD", "EMPLOYEE_QUALIFICATION"] as const;
export type DataChallengeTargetTypeName = (typeof DATA_CHALLENGE_TARGET_TYPES)[number];
const STATUSES = ["OPEN", "UNDER_REVIEW", "UPHELD", "REJECTED", "WITHDRAWN"] as const;

/** What the employee says is wrong. */
export const STATEMENT_MAX = 4000;
/** The annotation shown next to the data, or the reason of a rejection. */
export const RESOLUTION_MAX = 4000;

/** Self-service: the caller challenges one of THEIR OWN records. */
export const raiseDataChallengeSchema = z
  .object({ targetType: z.enum(DATA_CHALLENGE_TARGET_TYPES), targetId: id, statement: text(STATEMENT_MAX) })
  .strict();
export type RaiseDataChallengeInput = z.infer<typeof raiseDataChallengeSchema>;

export const assignDataChallengeSchema = z.object({ reviewerUserId: id }).strict();
export type AssignDataChallengeInput = z.infer<typeof assignDataChallengeSchema>;

/**
 * Upholding: ANNOTATED records `resolution` as the annotation shown next to the data. CORRECTED means the owning module
 * corrected the data with its own audit: for a coaching note this request carries the corrected text (`correctedBody`); for a
 * qualification the reviewer first corrects it through `/api/v1/qualifications/*` and names that audit event
 * (`correctionAuditEventId`). Metric values and training records have no correction path yet (they can be annotated).
 */
export const upholdDataChallengeSchema = z.discriminatedUnion("resolutionKind", [
  z.object({ resolutionKind: z.literal("ANNOTATED"), resolution: text(RESOLUTION_MAX) }).strict(),
  z
    .object({
      resolutionKind: z.literal("CORRECTED"),
      resolution: text(RESOLUTION_MAX),
      correctedBody: text(8000).optional(),
      correctionAuditEventId: id.optional(),
    })
    .strict(),
]);
export type UpholdDataChallengeInput = z.infer<typeof upholdDataChallengeSchema>;

export const rejectDataChallengeSchema = z.object({ reason: text(RESOLUTION_MAX) }).strict();
export type RejectDataChallengeInput = z.infer<typeof rejectDataChallengeSchema>;

export const listDataChallengesQuerySchema = pageQuerySchema
  .extend({
    status: z.enum(STATUSES).optional(),
    employeeId: id.optional(),
    reviewerId: id.optional(),
    targetType: z.enum(DATA_CHALLENGE_TARGET_TYPES).optional(),
  })
  .strict();
export type ListDataChallengesQuery = z.infer<typeof listDataChallengesQuerySchema>;
