/**
 * Status machine of a job (§7.2). Pure: the ONE place that says which status changes are allowed;
 * the jobs service calls `assertJobTransition` and never decides on its own.
 *
 * Default path (every edge here is `core`):
 *
 *   CREATED > PENDING_ASSIGNMENT > ASSIGNED > SCHEDULED > EN_ROUTE > ARRIVED > IN_PROGRESS > COMPLETED
 *     COMPLETED > AWAITING_REVIEW > CLOSED        (job types that require review)
 *     COMPLETED > CLOSED                          (all others)
 *
 * Exceptional statuses (CANCELLED, CUSTOMER_UNAVAILABLE, RESCHEDULED, FAILED, ON_HOLD,
 * REQUIRES_RETURN_VISIT) are entered through `optional` edges and always leave through at least one
 * `core` edge, so no job can be trapped.
 *
 * Tenant configuration can only NARROW the machine (§7.2 "invalid transitions must remain blocked"):
 * a tenant may switch off `optional` edges, which are named "FROM>TO" (`transitionKey`). Anything
 * else in a tenant's list (unknown edges, core edges, edges that never existed) is ignored, so a
 * tenant can never add a transition or remove one the default path needs.
 *
 * Some edges depend on the job's facts (an assignment, a scheduled slot, whether the job type
 * requires review): `transitionGuardProblem` states those rules, also purely.
 */
export const JOB_STATUSES = [
  "CREATED",
  "PENDING_ASSIGNMENT",
  "ASSIGNED",
  "SCHEDULED",
  "EN_ROUTE",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "AWAITING_REVIEW",
  "CLOSED",
  "CANCELLED",
  "CUSTOMER_UNAVAILABLE",
  "RESCHEDULED",
  "FAILED",
  "ON_HOLD",
  "REQUIRES_RETURN_VISIT",
] as const;
export type JobStatusValue = (typeof JOB_STATUSES)[number];

export interface JobTransitionRule {
  from: JobStatusValue;
  to: JobStatusValue;
  /** Core edges are always on; optional edges can be switched off by a tenant. */
  optional: boolean;
  /** Permission needed IN ADDITION to `jobs.edit` (review decisions). */
  permission?: "jobs.approve" | "jobs.reject";
}

const core = (from: JobStatusValue, to: JobStatusValue, permission?: JobTransitionRule["permission"]): JobTransitionRule => ({ from, to, optional: false, permission });
const optional = (from: JobStatusValue, to: JobStatusValue, permission?: JobTransitionRule["permission"]): JobTransitionRule => ({ from, to, optional: true, permission });

export const JOB_TRANSITIONS: readonly JobTransitionRule[] = [
  core("CREATED", "PENDING_ASSIGNMENT"),
  optional("CREATED", "CANCELLED"),

  core("PENDING_ASSIGNMENT", "ASSIGNED"),
  optional("PENDING_ASSIGNMENT", "ON_HOLD"),
  optional("PENDING_ASSIGNMENT", "CANCELLED"),

  core("ASSIGNED", "SCHEDULED"),
  core("ASSIGNED", "PENDING_ASSIGNMENT"), // unassigned
  optional("ASSIGNED", "ON_HOLD"),
  optional("ASSIGNED", "CANCELLED"),

  core("SCHEDULED", "EN_ROUTE"),
  core("SCHEDULED", "PENDING_ASSIGNMENT"), // unassigned
  optional("SCHEDULED", "RESCHEDULED"),
  optional("SCHEDULED", "ON_HOLD"),
  optional("SCHEDULED", "CANCELLED"),

  core("EN_ROUTE", "ARRIVED"),
  optional("EN_ROUTE", "SCHEDULED"), // started the wrong job (§25.3)
  optional("EN_ROUTE", "RESCHEDULED"),
  optional("EN_ROUTE", "CUSTOMER_UNAVAILABLE"),
  optional("EN_ROUTE", "CANCELLED"),

  core("ARRIVED", "IN_PROGRESS"),
  optional("ARRIVED", "CUSTOMER_UNAVAILABLE"),
  optional("ARRIVED", "RESCHEDULED"),
  optional("ARRIVED", "FAILED"),
  optional("ARRIVED", "CANCELLED"),

  core("IN_PROGRESS", "COMPLETED"),
  optional("IN_PROGRESS", "REQUIRES_RETURN_VISIT"),
  optional("IN_PROGRESS", "FAILED"),
  optional("IN_PROGRESS", "ON_HOLD"),
  optional("IN_PROGRESS", "CANCELLED"),

  core("COMPLETED", "AWAITING_REVIEW"), // only when the job type requires review (guard)
  core("COMPLETED", "CLOSED"), // only when it does not (guard)
  optional("COMPLETED", "REQUIRES_RETURN_VISIT"),

  core("AWAITING_REVIEW", "CLOSED", "jobs.approve"),
  optional("AWAITING_REVIEW", "IN_PROGRESS", "jobs.reject"), // review rejected: work reopened

  core("CUSTOMER_UNAVAILABLE", "RESCHEDULED"),
  optional("CUSTOMER_UNAVAILABLE", "SCHEDULED"),
  optional("CUSTOMER_UNAVAILABLE", "PENDING_ASSIGNMENT"),
  optional("CUSTOMER_UNAVAILABLE", "FAILED"),
  optional("CUSTOMER_UNAVAILABLE", "CANCELLED"),

  core("RESCHEDULED", "SCHEDULED"),
  optional("RESCHEDULED", "PENDING_ASSIGNMENT"),
  optional("RESCHEDULED", "ON_HOLD"),
  optional("RESCHEDULED", "CANCELLED"),

  // Leaving a hold toward PENDING_ASSIGNMENT is core: a hold must never trap a job.
  core("ON_HOLD", "PENDING_ASSIGNMENT"),
  optional("ON_HOLD", "ASSIGNED"),
  optional("ON_HOLD", "SCHEDULED"),
  optional("ON_HOLD", "CANCELLED"),

  core("FAILED", "CLOSED"),
  optional("FAILED", "REQUIRES_RETURN_VISIT"),
  optional("FAILED", "PENDING_ASSIGNMENT"),

  core("REQUIRES_RETURN_VISIT", "CLOSED"),
  optional("REQUIRES_RETURN_VISIT", "PENDING_ASSIGNMENT"),
  optional("REQUIRES_RETURN_VISIT", "SCHEDULED"),
  optional("REQUIRES_RETURN_VISIT", "CANCELLED"),
];

/** CLOSED and CANCELLED have no way out (a closed job is reopened by a new follow-up job, never by editing history). */
export const TERMINAL_JOB_STATUSES: readonly JobStatusValue[] = ["CLOSED", "CANCELLED"];
export const isTerminalJobStatus = (status: JobStatusValue): boolean => TERMINAL_JOB_STATUSES.includes(status);

/** "FROM>TO", the name a tenant uses to switch an optional edge off (`OperationsSettings.disabledJobTransitions`). */
export const transitionKey = (from: JobStatusValue, to: JobStatusValue): string => `${from}>${to}`;

/** Every edge a tenant may switch off. */
export const OPTIONAL_TRANSITION_KEYS: readonly string[] = JOB_TRANSITIONS.filter((rule) => rule.optional).map((rule) => transitionKey(rule.from, rule.to));

/**
 * The tenant's valid switched-off edges: unknown names and core edges are dropped, so a stored list
 * can never narrow the default path (and a later release that makes an edge core simply stops honouring it).
 */
export function effectiveDisabledTransitions(stored: readonly string[]): Set<string> {
  const optionalKeys = new Set(OPTIONAL_TRANSITION_KEYS);
  return new Set(stored.filter((key) => optionalKeys.has(key)));
}

/** The names in `requested` that a tenant may NOT switch off (unknown or core); empty when all are fine. */
export const invalidDisabledTransitions = (requested: readonly string[]): string[] => requested.filter((key) => !OPTIONAL_TRANSITION_KEYS.includes(key));

export function findTransition(from: JobStatusValue, to: JobStatusValue, disabled: ReadonlySet<string> = new Set()): JobTransitionRule | null {
  const rule = JOB_TRANSITIONS.find((candidate) => candidate.from === from && candidate.to === to);
  if (!rule) return null;
  return rule.optional && disabled.has(transitionKey(from, to)) ? null : rule;
}

export const canTransitionJob = (from: JobStatusValue, to: JobStatusValue, disabled: ReadonlySet<string> = new Set()): boolean =>
  findTransition(from, to, disabled) !== null;

/** Statuses reachable from `from` right now, given the tenant's switched-off edges. */
export const allowedNextStatuses = (from: JobStatusValue, disabled: ReadonlySet<string> = new Set()): JobStatusValue[] =>
  JOB_TRANSITIONS.filter((rule) => rule.from === from && findTransition(rule.from, rule.to, disabled)).map((rule) => rule.to);

/** Targets that need a reason on the history row (something went wrong, or work stops). */
export const REASON_REQUIRED_STATUSES: readonly JobStatusValue[] = [
  "CANCELLED",
  "CUSTOMER_UNAVAILABLE",
  "RESCHEDULED",
  "FAILED",
  "ON_HOLD",
  "REQUIRES_RETURN_VISIT",
];

/**
 * What an execution-only grant (Technician `jobs.edit {fields:"execution"}`) may move a job to through the
 * plain `POST /jobs/{id}/transition`: leaving for the job. The next two steps are field EVENTS that carry
 * more than a status (a location, an offline timestamp), so they have their own endpoints and are listed
 * in `TECHNICIAN_FIELD_EVENT_STEPS` instead: arrival (`/arrive`, geofence check) and start of work
 * (`/start-work`). Completion is reported through the job outcome (§9.1).
 */
export const TECHNICIAN_TARGET_STATUSES: readonly JobStatusValue[] = ["EN_ROUTE"];

/**
 * The steps a technician takes through field-event endpoints (§8.3, §8.4): EN_ROUTE > ARRIVED > IN_PROGRESS.
 * Both are `core` edges, so a tenant cannot switch them off. Pausing and resuming work is not offered: the
 * machine has no ON_HOLD > IN_PROGRESS edge, so a pause could not be undone by the technician.
 */
export const TECHNICIAN_FIELD_EVENT_STEPS: readonly { from: JobStatusValue; to: JobStatusValue }[] = [
  { from: "EN_ROUTE", to: "ARRIVED" },
  { from: "ARRIVED", to: "IN_PROGRESS" },
];

export const isTechnicianFieldEventStep = (from: JobStatusValue, to: JobStatusValue): boolean =>
  TECHNICIAN_FIELD_EVENT_STEPS.some((step) => step.from === from && step.to === to);

/** Where the work is under way or done: the assignment can no longer be changed by dispatch. */
export const FIELD_IN_PROGRESS_STATUSES: readonly JobStatusValue[] = ["EN_ROUTE", "ARRIVED", "IN_PROGRESS"];

/** Statuses in which a job may be given to (or taken from) someone. */
export const ASSIGNABLE_STATUSES: readonly JobStatusValue[] = [
  "PENDING_ASSIGNMENT",
  "ASSIGNED",
  "SCHEDULED",
  "RESCHEDULED",
  "ON_HOLD",
  "CUSTOMER_UNAVAILABLE",
  "REQUIRES_RETURN_VISIT",
];

/** Statuses in which the appointment window / scheduled slot may still be moved. */
export const RESCHEDULABLE_STATUSES: readonly JobStatusValue[] = ASSIGNABLE_STATUSES;

/** Statuses whose assignments are ended so the work stops granting ASSIGNED access (customers README contract). */
export const ASSIGNMENT_ENDING_STATUSES: readonly JobStatusValue[] = ["CLOSED", "CANCELLED"];

/** The facts about a job that some edges depend on. */
export interface TransitionFacts {
  requiresReview: boolean;
  hasActiveAssignment: boolean;
  hasScheduledSlot: boolean;
}

/**
 * Rules that depend on the job, not just on the two statuses. Returns a short English reason for the
 * refusal or null when the change is fine. (Clients get the 409 code; the text is a stable default.)
 */
export function transitionGuardProblem(from: JobStatusValue, to: JobStatusValue, facts: TransitionFacts): string | null {
  if (from === "COMPLETED" && to === "AWAITING_REVIEW" && !facts.requiresReview) return "This job type does not require review: close the job instead.";
  if (from === "COMPLETED" && to === "CLOSED" && facts.requiresReview) return "This job type requires review: move the job to awaiting review first.";
  const needsAssignee: JobStatusValue[] = ["ASSIGNED", "SCHEDULED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS"];
  if (needsAssignee.includes(to) && !facts.hasActiveAssignment) return "Assign the job to an employee or team first.";
  if (to === "SCHEDULED" && !facts.hasScheduledSlot) return "Set the scheduled time first.";
  return null;
}

/**
 * Why `from` > `to` is refused right now, or null when it is allowed: no such edge, the tenant switched
 * it off, or a job-dependent guard failed. The service turns a problem into `InvalidStateTransitionError`.
 */
export function transitionProblem(
  from: JobStatusValue,
  to: JobStatusValue,
  disabled: ReadonlySet<string>,
  facts: TransitionFacts,
): { code: "NOT_ALLOWED" | "DISABLED" | "GUARD"; message: string } | null {
  const rule = JOB_TRANSITIONS.find((candidate) => candidate.from === from && candidate.to === to);
  if (!rule) return { code: "NOT_ALLOWED", message: `A job cannot move from ${from} to ${to}.` };
  if (rule.optional && disabled.has(transitionKey(from, to))) return { code: "DISABLED", message: `Your company has switched off the change from ${from} to ${to}.` };
  const guard = transitionGuardProblem(from, to, facts);
  return guard ? { code: "GUARD", message: guard } : null;
}

// ───────────────────────── Appointment checks (§25.2) ─────────────────────────

export type JobWarningCode = "DURATION_EXCEEDS_WINDOW" | "SLOT_SHORTER_THAN_DURATION" | "ASSIGNEE_ELIGIBILITY_CONFLICT";
export interface JobWarning {
  code: JobWarningCode;
  params: Record<string, number | string>;
}

const minutesBetween = (start: Date, end: Date): number => Math.round((end.getTime() - start.getTime()) / 60_000);

/**
 * §25.2 "Job duration exceeds appointment window": a conflict to DISPLAY, never a refusal (the
 * dispatcher decides). The customer-facing arrival window is compared with the estimated duration,
 * and a concrete scheduled slot too. Language-neutral `{ code, params }`, translated by clients.
 */
export function appointmentWarnings(input: {
  estimatedDurationMinutes: number;
  window?: { start: Date; end: Date } | null;
  slot?: { start: Date; end: Date } | null;
}): JobWarning[] {
  const warnings: JobWarning[] = [];
  if (input.window) {
    const windowMinutes = minutesBetween(input.window.start, input.window.end);
    if (input.estimatedDurationMinutes > windowMinutes) {
      warnings.push({ code: "DURATION_EXCEEDS_WINDOW", params: { estimatedDurationMinutes: input.estimatedDurationMinutes, windowMinutes } });
    }
  }
  if (input.slot) {
    const slotMinutes = minutesBetween(input.slot.start, input.slot.end);
    if (input.estimatedDurationMinutes > slotMinutes) {
      warnings.push({ code: "SLOT_SHORTER_THAN_DURATION", params: { estimatedDurationMinutes: input.estimatedDurationMinutes, slotMinutes } });
    }
  }
  return warnings;
}
