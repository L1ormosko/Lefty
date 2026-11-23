import { z } from "zod";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the dispatch API. Routes validate with them; services trust the types. */

const id = z.string().trim().min(1).max(64);
const reason = z.string().trim().min(1).max(500);

export const DISPATCH_MODES = ["MANUAL", "AI_ASSISTED", "RULE_BASED_AUTO", "OPTIMIZATION"] as const;
/** Modes this phase actually runs. The other two are configuration values that are refused (§7.5). */
export const AVAILABLE_DISPATCH_MODES: readonly (typeof DISPATCH_MODES)[number][] = ["MANUAL", "AI_ASSISTED"];

export const jobIdParams = z.object({ id });
export const recommendationIdParams = z.object({ id });

export const updateDispatchSettingsSchema = z.object({ mode: z.enum(DISPATCH_MODES) }).strict();
export type UpdateDispatchSettingsInput = z.infer<typeof updateDispatchSettingsSchema>;

export const listRecommendationsQuerySchema = pageQuerySchema;
export type ListRecommendationsQuery = z.infer<typeof listRecommendationsQuerySchema>;

/** Approve the top-ranked candidate as is. The reason is optional. */
export const approveRecommendationSchema = z.object({ reason: reason.optional() }).strict();
export type ApproveRecommendationInput = z.infer<typeof approveRecommendationSchema>;

/** Reject the whole recommendation (the job stays pending). A reason is required so the decision is explainable. */
export const rejectRecommendationSchema = z.object({ reason }).strict();
export type RejectRecommendationInput = z.infer<typeof rejectRecommendationSchema>;

/**
 * Choose someone else. `reason` is required. `override` is only needed (and only honoured, for a
 * `jobs.approve` holder) when the chosen employee fails the hard eligibility rules.
 */
export const modifyRecommendationSchema = z
  .object({ employeeId: id, reason, override: z.object({ reason }).strict().optional() })
  .strict();
export type ModifyRecommendationInput = z.infer<typeof modifyRecommendationSchema>;
