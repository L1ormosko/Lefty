import { z } from "zod";
import { PRESENCE_VALUES, RECOVERY_PRIORITIES } from "@/lib/recovery-rules";
import { RECOVERY_STATUSES } from "@/lib/recovery-lifecycle";
import { pageQuerySchema } from "@/server/core";

/** Zod schemas of the lead-recovery API. Rule content (`conditions`, `actions`) is validated by `validateRuleDefinition`. */

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);
const money = z.number().int().min(0).max(2_000_000_000);

// ───────────── Rules ─────────────

const ruleContent = {
  name: text(120),
  description: text(2000).optional(),
  priority: z.number().int().min(0).max(10_000).default(100),
  trigger: text(64).default("job.not_converted"),
  /** Validated against the closed vocabulary by `validateRuleDefinition` (unknown keys and discounts are refused). */
  conditions: z.record(z.unknown()).default({}),
  actions: z.array(z.unknown()).min(1).max(10),
  /** The org unit the rule applies to (and below); omitted = the whole tenant. */
  orgUnitId: id.optional(),
  cooldownMinutes: z.number().int().min(0).max(60 * 24 * 365).default(0),
};

export const createRuleSchema = z.object({ ruleKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, "lower-case letters, digits, . _ -"), ...ruleContent }).strict();
export type CreateRuleInput = z.infer<typeof createRuleSchema>;

/** Edits a DRAFT in place. Any other status needs a new version. */
export const updateRuleSchema = z
  .object({
    name: ruleContent.name.optional(),
    description: text(2000).nullable().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    conditions: z.record(z.unknown()).optional(),
    actions: z.array(z.unknown()).min(1).max(10).optional(),
    orgUnitId: id.nullable().optional(),
    cooldownMinutes: z.number().int().min(0).max(60 * 24 * 365).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), "Send at least one field to change.");
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

export const ruleIdParams = z.object({ id: id });
export const caseIdParams = z.object({ id: id });

export const ruleDecisionSchema = z.object({ reason: text(500).optional() }).strict();
export type RuleDecisionInput = z.infer<typeof ruleDecisionSchema>;

export const listRulesQuerySchema = pageQuerySchema.extend({
  status: z.enum(["DRAFT", "PENDING_APPROVAL", "ACTIVE", "INACTIVE", "SUPERSEDED"]).optional(),
  ruleKey: z.string().trim().min(1).max(63).optional(),
  /** Only the newest version of each rule (default true). */
  latestOnly: z.enum(["true", "false"]).default("true"),
});
export type ListRulesQuery = z.infer<typeof listRulesQuerySchema>;

/**
 * Dry run: evaluate a stored rule (`ruleId`) or an unsaved `definition` against a real not-converted outcome. Nothing is
 * written. `presence` overrides the presence fact ("what if the technician had left").
 */
export const dryRunSchema = z
  .object({
    jobOutcomeId: id,
    ruleId: id.optional(),
    definition: z
      .object({ trigger: text(64).default("job.not_converted"), conditions: z.record(z.unknown()).default({}), actions: z.array(z.unknown()).min(1).max(10), cooldownMinutes: z.number().int().min(0).default(0) })
      .strict()
      .optional(),
    presence: z.enum(PRESENCE_VALUES).optional(),
  })
  .strict()
  .refine((value) => (value.ruleId === undefined) !== (value.definition === undefined), "Send exactly one of ruleId and definition.");
export type DryRunInput = z.infer<typeof dryRunSchema>;

// ───────────── Cases ─────────────

export const listCasesQuerySchema = pageQuerySchema.extend({
  status: z.enum(RECOVERY_STATUSES).optional(),
  /** open = not RECOVERED / NOT_RECOVERED / CLOSED. */
  open: z.enum(["true", "false"]).optional(),
  priority: z.enum(RECOVERY_PRIORITIES).optional(),
  assignedToId: z.union([id, z.literal("me"), z.literal("none")]).optional(),
  customerId: id.optional(),
  jobId: id.optional(),
  orgUnitId: id.optional(),
  presenceStatus: z.enum(PRESENCE_VALUES).optional(),
});
export type ListCasesQuery = z.infer<typeof listCasesQuerySchema>;

export const assignCaseSchema = z.object({ assigneeId: id.nullable() }).strict();
export type AssignCaseInput = z.infer<typeof assignCaseSchema>;

export const changeCaseStatusSchema = z
  .object({
    status: z.enum(["CONTACTING", "CUSTOMER_REACHED", "FOLLOW_UP_REQUIRED", "NOT_RECOVERED", "CLOSED"]),
    reason: text(500).optional(),
  })
  .strict();
export type ChangeCaseStatusInput = z.infer<typeof changeCaseStatusSchema>;

/** Employee-recorded estimate of what recovery could bring (never counted as revenue). */
export const updateCaseSchema = z
  .object({ estimatedValueMinor: money.nullable().optional(), priority: z.enum(RECOVERY_PRIORITIES).optional() })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), "Send at least one field to change.");
export type UpdateCaseInput = z.infer<typeof updateCaseSchema>;

export const recordAttemptSchema = z
  .object({
    channel: z.enum(["PHONE", "SMS", "EMAIL", "IN_PERSON", "CHAT", "OTHER"]),
    outcome: z.enum(["REACHED", "NO_ANSWER", "VOICEMAIL", "BUSY", "WRONG_NUMBER", "CALLBACK_REQUESTED", "DECLINED"]).optional(),
    occurredAt: z.coerce.date().optional(),
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    notes: text(4000).optional(),
    /** An amount the EMPLOYEE quoted, if any. The platform never offers one (§9.6). */
    offeredAmountMinor: money.optional(),
  })
  .strict();
export type RecordAttemptInput = z.infer<typeof recordAttemptSchema>;

/**
 * Confirms the recovery (§9.7): the confirmed amounts are facts the employee enters (or that come from the recovered job);
 * `recoveredJobId` / `recoveredLeadId` link the new work to the original customer. Estimates are never copied here.
 */
export const recoverCaseSchema = z
  .object({
    recoveredAmountMinor: money,
    collectedAmountMinor: money.optional(),
    recoveredJobId: id.optional(),
    recoveredLeadId: id.optional(),
    recoveredAt: z.coerce.date().optional(),
    note: text(500).optional(),
  })
  .strict();
export type RecoverCaseInput = z.infer<typeof recoverCaseSchema>;

export const summaryQuerySchema = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), orgUnitId: id.optional() }).strict();
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
