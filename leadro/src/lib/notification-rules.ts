/**
 * Pure rules of the notifications engine (§14): what may go into a notification's parameters, who
 * opted out of what, and how failed deliveries are retried. No Prisma, no Next: unit-testable.
 */

/** Values a notification parameter may hold. Display text is never stored; clients render by key. */
export type NotificationParamValue = string | number | boolean;
export type NotificationParams = Record<string, NotificationParamValue>;

const PARAM_NAME = /^[a-z][A-Za-z0-9]{0,39}$/;
/**
 * Strings in params must look like identifiers or codes (cuids, enum values, dotted keys). Spaces,
 * "@", "+" and similar are rejected, which keeps names, emails and phone numbers out of the JSON
 * column (docs/ERD.md "Contracts for JSON and polymorphic references": ids only, no PII).
 */
const PARAM_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_PARAMS = 10;

/** @returns a human-readable problem, or null when `params` honours the ids-only contract. */
export function findParamsProblem(params: Record<string, unknown>): string | null {
  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) return `at most ${MAX_PARAMS} params are allowed`;
  for (const [name, value] of entries) {
    if (!PARAM_NAME.test(name)) return `param name "${name}" must be camelCase letters and digits`;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return `param "${name}" must be a finite number`;
    } else if (typeof value === "string") {
      if (!PARAM_STRING.test(value)) return `param "${name}" must be an identifier or code, not free text`;
    } else if (typeof value !== "boolean") {
      return `param "${name}" must be a string, number or boolean`;
    }
  }
  return null;
}

/** One stored preference row, reduced to what the opt-out decision needs. */
export interface PreferenceRow {
  eventType: string;
  channel: string;
  enabled: boolean;
}

/** `eventType` value of a preference that covers every non-critical event. */
export const ALL_EVENTS = "*";

/**
 * Has the recipient opted out of `channel` for `eventType`? An absent row means "enabled" (tenant
 * default). A row for the exact event type wins over the `*` row, so a user can mute everything and
 * still keep one event. Critical notifications never call this (§14.1).
 */
export function isChannelOptedOut(rows: readonly PreferenceRow[], eventType: string, channel: string): boolean {
  const forChannel = rows.filter((row) => row.channel === channel);
  const specific = forChannel.find((row) => row.eventType === eventType);
  if (specific) return !specific.enabled;
  const everything = forChannel.find((row) => row.eventType === ALL_EVENTS);
  return everything ? !everything.enabled : false;
}

/** Attempts per channel before a failing delivery is marked EXHAUSTED. */
export const MAX_DELIVERY_ATTEMPTS = 3;

const RETRY_DELAYS_MS = [60_000, 5 * 60_000]; // after attempt 1, after attempt 2

/** Delay before the retry that follows failed attempt number `attempt`, or null when none is left. */
export function retryDelayMs(attempt: number): number | null {
  if (attempt >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}
