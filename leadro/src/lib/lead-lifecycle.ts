/**
 * The lead status machine (§6.3). Pure: the ONE place that says which status changes are allowed.
 * The leads service calls `canTransitionLead` / `assertLeadTransition` and never decides on its own.
 *
 *   NEW ──> UNASSIGNED ──> ASSIGNED ──> CONTACT_ATTEMPTED ──> CONTACTED ──> QUALIFIED ──> SCHEDULED ──> DISPATCHED
 *     \________________________/  \__________________________/  (ASSIGNED may skip straight to CONTACTED)
 *                                                                  every "owned" status ──> CONVERTED (via conversion only)
 *
 * Closing statuses: LOST (reason required), DUPLICATE (names the lead it duplicates), CANCELLED (reason
 * required, e.g. the customer asked to cancel), CONVERTED (a job exists). CONVERTED and CANCELLED are
 * final; LOST and DUPLICATE can be reopened to UNASSIGNED.
 *
 * Tenants may only NARROW the machine: `OperationsSettings.disabledLeadTransitions` lists `"FROM>TO"` strings and
 * only OPTIONAL transitions can be switched off (the default path can never be blocked, and an entry that
 * names something that is not an optional transition is ignored, so a tenant can never ADD a transition).
 */

export const LEAD_STATUSES = [
  "NEW",
  "UNASSIGNED",
  "ASSIGNED",
  "CONTACT_ATTEMPTED",
  "CONTACTED",
  "QUALIFIED",
  "SCHEDULED",
  "DISPATCHED",
  "CONVERTED",
  "LOST",
  "DUPLICATE",
  "CANCELLED",
] as const;

export type LeadStatusValue = (typeof LEAD_STATUSES)[number];

interface TransitionRule {
  to: LeadStatusValue;
  /** Optional transitions can be switched off by a tenant; the others are the default path. */
  optional: boolean;
}

const path = (to: LeadStatusValue): TransitionRule => ({ to, optional: false });
const optional = (to: LeadStatusValue): TransitionRule => ({ to, optional: true });

/** Statuses a person may close an open lead with. */
const CLOSING: TransitionRule[] = [optional("LOST"), optional("DUPLICATE"), optional("CANCELLED")];

export const LEAD_TRANSITIONS: Readonly<Record<LeadStatusValue, readonly TransitionRule[]>> = {
  NEW: [path("UNASSIGNED"), path("ASSIGNED"), optional("DUPLICATE"), optional("CANCELLED")],
  UNASSIGNED: [path("ASSIGNED"), optional("LOST"), optional("DUPLICATE"), optional("CANCELLED")],
  ASSIGNED: [path("CONTACT_ATTEMPTED"), optional("CONTACTED"), optional("UNASSIGNED"), ...CLOSING],
  CONTACT_ATTEMPTED: [path("CONTACTED"), optional("UNASSIGNED"), ...CLOSING],
  CONTACTED: [path("QUALIFIED"), optional("CONTACT_ATTEMPTED"), optional("UNASSIGNED"), ...CLOSING],
  QUALIFIED: [path("SCHEDULED"), path("CONVERTED"), optional("CONTACTED"), optional("UNASSIGNED"), ...CLOSING],
  SCHEDULED: [path("DISPATCHED"), path("CONVERTED"), optional("QUALIFIED"), optional("UNASSIGNED"), ...CLOSING],
  DISPATCHED: [path("CONVERTED"), optional("SCHEDULED"), optional("UNASSIGNED"), ...CLOSING],
  CONVERTED: [],
  LOST: [optional("UNASSIGNED")],
  DUPLICATE: [optional("UNASSIGNED")],
  CANCELLED: [],
};

/** The key a tenant uses in `disabledLeadTransitions`. */
export const transitionKey = (from: LeadStatusValue, to: LeadStatusValue): string => `${from}>${to}`;

const isOptional = (from: LeadStatusValue, to: LeadStatusValue): boolean =>
  LEAD_TRANSITIONS[from].some((rule) => rule.to === to && rule.optional);

/** Disabled entries that really name an optional transition (anything else is ignored: a tenant can only narrow). */
function effectiveDisabled(disabled: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const entry of disabled) {
    const [from, to] = entry.split(">") as [LeadStatusValue, LeadStatusValue];
    if (LEAD_TRANSITIONS[from] && isOptional(from, to)) result.add(entry);
  }
  return result;
}

/** The statuses reachable from `from`, after the tenant's narrowing. */
export function allowedLeadTransitions(from: LeadStatusValue, disabled: readonly string[] = []): LeadStatusValue[] {
  const off = effectiveDisabled(disabled);
  return LEAD_TRANSITIONS[from].filter((rule) => !off.has(transitionKey(from, rule.to))).map((rule) => rule.to);
}

export function canTransitionLead(from: LeadStatusValue, to: LeadStatusValue, disabled: readonly string[] = []): boolean {
  return allowedLeadTransitions(from, disabled).includes(to);
}

/** Every optional transition, as `"FROM>TO"`: what a tenant may switch off. */
export const OPTIONAL_LEAD_TRANSITIONS: readonly string[] = LEAD_STATUSES.flatMap((from) =>
  LEAD_TRANSITIONS[from].filter((rule) => rule.optional).map((rule) => transitionKey(from, rule.to)),
);

/** Statuses in which somebody owns the lead: an ACTIVE assignment must exist (ASSIGNED ... DISPATCHED). */
export const OWNED_STATUSES: readonly LeadStatusValue[] = [
  "ASSIGNED",
  "CONTACT_ATTEMPTED",
  "CONTACTED",
  "QUALIFIED",
  "SCHEDULED",
  "DISPATCHED",
];

/** Closing statuses: the lead is finished (or finished unless reopened) and its owner's assignment ends. */
export const CLOSED_STATUSES: readonly LeadStatusValue[] = ["CONVERTED", "LOST", "DUPLICATE", "CANCELLED"];

/** Statuses that need a human-given reason (stored as `closedReason` and in the history row). */
export const REASON_REQUIRED_STATUSES: readonly LeadStatusValue[] = ["LOST", "CANCELLED"];

export const isOwnedStatus = (status: LeadStatusValue): boolean => OWNED_STATUSES.includes(status);
export const isClosedStatus = (status: LeadStatusValue): boolean => CLOSED_STATUSES.includes(status);

/**
 * Statuses a person cannot request directly through the status endpoint: ASSIGNED needs an owner (assignment
 * action), and CONVERTED needs a job (conversion action). Both still appear in the machine above.
 */
export const ACTION_ONLY_STATUSES: readonly LeadStatusValue[] = ["ASSIGNED", "CONVERTED"];

/**
 * What a person may request through the status endpoint from `from`: the machine's moves minus the action-only
 * statuses, and minus UNASSIGNED while somebody owns the lead (releasing an owner is the unassign action, which
 * applies the §25.1 open-contact-attempt rule that a plain status change would bypass).
 */
export function requestableLeadStatuses(from: LeadStatusValue, disabled: readonly string[] = []): LeadStatusValue[] {
  return allowedLeadTransitions(from, disabled).filter(
    (to) => !ACTION_ONLY_STATUSES.includes(to) && !(to === "UNASSIGNED" && isOwnedStatus(from)),
  );
}
