import { z } from "zod";

/**
 * Pure rules of the Lead Recovery Engine (§9.3 - 9.7): what a rule may say, whether it matches a not-converted visit,
 * whether it is high impact, whether it is in cooldown, and what a technician's presence is worth. No Prisma, no clock:
 * the service passes everything in, so every decision here is unit-testable and explainable.
 *
 * Safety (§9.6): there is NO discount action. The action vocabulary is closed, every object is strict, and any key or type
 * that looks like a price reduction is refused with its own message, so a future "just add a field" cannot sneak one in.
 */

export const RECOVERY_TRIGGERS = ["job.not_converted"] as const;
export type RecoveryTrigger = (typeof RECOVERY_TRIGGERS)[number];

export const RECOVERY_OUTCOMES = ["NOT_SOLD", "WORK_NOT_POSSIBLE"] as const;
export const PRESENCE_VALUES = ["AT_LOCATION", "LEFT_LOCATION", "UNKNOWN"] as const;
export type PresenceValue = (typeof PRESENCE_VALUES)[number];
export const RECOVERY_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type RecoveryPriority = (typeof RECOVERY_PRIORITIES)[number];
export const RECOMMENDATION_CODES = ["call_customer", "send_quote_reminder", "schedule_revisit", "review_manually"] as const;
export const NOTIFY_AUDIENCES = ["lead_operations"] as const;

const id = z.string().trim().min(1).max(64);
const idList = z.array(id).min(1).max(50);

/** What a visit must look like for the rule to apply. An omitted condition does not restrict. */
export const conditionsSchema = z
  .object({
    outcomes: z.array(z.enum(RECOVERY_OUTCOMES)).min(1).max(2).optional(),
    lostReasonIds: idList.optional(),
    jobTypeIds: idList.optional(),
    presence: z.array(z.enum(PRESENCE_VALUES)).min(1).max(3).optional(),
    minValueMinor: z.number().int().min(0).max(2_000_000_000).optional(),
    maxValueMinor: z.number().int().min(0).max(2_000_000_000).optional(),
    /** true: only reasons flagged recoverable; false: only the others. Absent: any. */
    recoverableReason: z.boolean().optional(),
    customerRequestedFollowUp: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.minValueMinor === undefined || value.maxValueMinor === undefined || value.minValueMinor <= value.maxValueMinor, {
    message: "minValueMinor cannot exceed maxValueMinor",
    path: ["minValueMinor"],
  });
export type RuleConditions = z.infer<typeof conditionsSchema>;

const priority = z.enum(RECOVERY_PRIORITIES);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_case"), priority: priority.optional() }).strict(),
  z.object({ type: z.literal("set_priority"), priority, score: z.number().int().min(0).max(1000).optional() }).strict(),
  z.object({ type: z.literal("notify"), audience: z.enum(NOTIFY_AUDIENCES).default("lead_operations") }).strict(),
  z
    .object({ type: z.literal("create_follow_up"), dueInMinutes: z.number().int().min(1).max(60 * 24 * 30), priority: priority.optional() })
    .strict(),
  z.object({ type: z.literal("recommend"), code: z.enum(RECOMMENDATION_CODES) }).strict(),
]);
export type RuleAction = z.infer<typeof actionSchema>;
export type RuleActionType = RuleAction["type"];

const DISCOUNT_WORDS = /discount|coupon|rebate|price[_-]?cut|percent[_-]?off|markdown|promo/i;

/** A key or value that talks about discounts, anywhere in the (unparsed) definition; returns its path. */
function findDiscountWord(value: unknown, path = ""): string | null {
  if (typeof value === "string") return DISCOUNT_WORDS.test(value) ? path || "(value)" : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findDiscountWord(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (DISCOUNT_WORDS.test(key)) return `${path}.${key}`;
      const found = findDiscountWord(entry, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

export const actionsSchema = z.array(actionSchema).min(1).max(10);

export interface DefinitionProblem {
  path: string;
  message: string;
}

export interface RuleDefinition {
  trigger: RecoveryTrigger;
  conditions: RuleConditions;
  actions: RuleAction[];
}

/** Validates a rule's content. Returns the parsed definition or every problem found (never throws). Refuses discounts (§9.6). */
export function validateRuleDefinition(input: {
  trigger: unknown;
  conditions: unknown;
  actions: unknown;
}): { ok: true; definition: RuleDefinition } | { ok: false; problems: DefinitionProblem[] } {
  const problems: DefinitionProblem[] = [];
  const discount = findDiscountWord({ conditions: input.conditions, actions: input.actions }, "");
  if (discount) problems.push({ path: discount.replace(/^\./, ""), message: "Recovery rules never offer discounts (§9.6)." });

  const trigger = RECOVERY_TRIGGERS.find((candidate) => candidate === input.trigger);
  if (!trigger) problems.push({ path: "trigger", message: `Unknown trigger. Supported: ${RECOVERY_TRIGGERS.join(", ")}.` });

  const conditions = conditionsSchema.safeParse(input.conditions);
  if (!conditions.success) for (const issue of conditions.error.issues) problems.push({ path: ["conditions", ...issue.path].join("."), message: issue.message });
  const actions = actionsSchema.safeParse(input.actions);
  if (!actions.success) for (const issue of actions.error.issues) problems.push({ path: ["actions", ...issue.path].join("."), message: issue.message });

  if (problems.length > 0 || !trigger || !conditions.success || !actions.success) return { ok: false, problems };
  return { ok: true, definition: { trigger, conditions: conditions.data, actions: actions.data } };
}

/**
 * Spec 21.3 / ERD: an action that creates high-priority cases, notifies people or creates tasks changes what staff do, so
 * activating such a rule needs a second person. `recommend` and a plain case only annotate. The service stores this derived
 * flag; the author cannot lower it.
 */
export function isHighImpact(actions: readonly RuleAction[]): boolean {
  return actions.some((action) => {
    switch (action.type) {
      case "notify":
      case "create_follow_up":
        return true;
      case "create_case":
        return action.priority === "HIGH" || action.priority === "URGENT";
      case "set_priority":
        return action.priority === "URGENT";
      case "recommend":
        return false;
    }
  });
}

const PRIORITY_RANK: Record<RecoveryPriority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };
export const higherPriority = (a: RecoveryPriority, b: RecoveryPriority): RecoveryPriority => (PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b);

/** The facts of one not-converted visit a rule is matched against. Ids, enums and numbers only. */
export interface RecoveryFacts {
  outcome: string;
  lostReasonId: string | null;
  lostReasonRecoverable: boolean | null;
  jobTypeId: string;
  /** Quoted value of the visit (null = unknown). A condition on value never matches an unknown value. */
  valueMinor: number | null;
  presence: PresenceValue;
  customerRequestedFollowUp: boolean;
}

export interface ConditionCheck {
  condition: keyof RuleConditions;
  passed: boolean;
  /** Machine-readable detail for the dry-run explanation (ids / codes / numbers). */
  expected: unknown;
  actual: unknown;
}

export interface MatchResult {
  matched: boolean;
  checks: ConditionCheck[];
}

/** Evaluates every condition (no short-circuit, so a dry run explains all of them). An empty condition set matches every visit. */
export function matchConditions(conditions: RuleConditions, facts: RecoveryFacts): MatchResult {
  const checks: ConditionCheck[] = [];
  const check = (condition: keyof RuleConditions, passed: boolean, expected: unknown, actual: unknown) => checks.push({ condition, passed, expected, actual });

  if (conditions.outcomes) check("outcomes", (conditions.outcomes as string[]).includes(facts.outcome), conditions.outcomes, facts.outcome);
  if (conditions.lostReasonIds) check("lostReasonIds", facts.lostReasonId !== null && conditions.lostReasonIds.includes(facts.lostReasonId), conditions.lostReasonIds, facts.lostReasonId);
  if (conditions.jobTypeIds) check("jobTypeIds", conditions.jobTypeIds.includes(facts.jobTypeId), conditions.jobTypeIds, facts.jobTypeId);
  if (conditions.presence) check("presence", conditions.presence.includes(facts.presence), conditions.presence, facts.presence);
  if (conditions.minValueMinor !== undefined) check("minValueMinor", facts.valueMinor !== null && facts.valueMinor >= conditions.minValueMinor, conditions.minValueMinor, facts.valueMinor);
  if (conditions.maxValueMinor !== undefined) check("maxValueMinor", facts.valueMinor !== null && facts.valueMinor <= conditions.maxValueMinor, conditions.maxValueMinor, facts.valueMinor);
  if (conditions.recoverableReason !== undefined) {
    check("recoverableReason", facts.lostReasonRecoverable !== null && facts.lostReasonRecoverable === conditions.recoverableReason, conditions.recoverableReason, facts.lostReasonRecoverable);
  }
  if (conditions.customerRequestedFollowUp !== undefined) {
    check("customerRequestedFollowUp", facts.customerRequestedFollowUp === conditions.customerRequestedFollowUp, conditions.customerRequestedFollowUp, facts.customerRequestedFollowUp);
  }
  return { matched: checks.every((entry) => entry.passed), checks };
}

/**
 * Loop safety (§9.6): the same rule does not fire again for the same customer inside its cooldown window.
 * `lastFiredAt` is the latest run of the rule for the customer that actually fired actions. A cooldown of 0 never blocks.
 */
export function isInCooldown(cooldownMinutes: number, lastFiredAt: Date | null, now: Date): boolean {
  if (cooldownMinutes <= 0 || !lastFiredAt) return false;
  return now.getTime() - lastFiredAt.getTime() < cooldownMinutes * 60_000;
}

/** Why presence is UNKNOWN (machine codes stored on the case). */
export type PresenceUnknownReason = "no_location" | "stale_location" | "inaccurate_location" | "no_coordinates";

export interface PresenceInput {
  /** Straight-line distance from the latest valid position to the job's address; null when either has no coordinates. */
  distanceM: number | null;
  /** True when a valid (fresh, accurate) position exists. */
  hasValidLocation: boolean;
  /** Why there is none, when it matters (set by the service from the latest event of any quality). */
  invalidReason?: Exclude<PresenceUnknownReason, "no_coordinates">;
  /** Geofence radius for the site. */
  radiusM: number;
  accuracyM: number | null;
}

export type PresenceResult = { status: "AT_LOCATION" | "LEFT_LOCATION"; reason: null } | { status: "UNKNOWN"; reason: PresenceUnknownReason };

/**
 * UNKNOWN unless there is valid recent data AND the site has coordinates (§26.5). Distance inside the radius = AT_LOCATION,
 * otherwise LEFT_LOCATION. A GPS fix is never proof; the confidence wording belongs to the client (§17).
 */
export function classifyPresence(input: PresenceInput): PresenceResult {
  if (!input.hasValidLocation) return { status: "UNKNOWN", reason: input.invalidReason ?? "no_location" };
  if (input.distanceM === null || input.accuracyM === null) return { status: "UNKNOWN", reason: "no_coordinates" };
  return { status: input.distanceM <= input.radiusM ? "AT_LOCATION" : "LEFT_LOCATION", reason: null };
}
