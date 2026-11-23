/**
 * The follow-up task status machine (§5.6, §5.9). Pure: the ONE place that says which status changes are allowed and
 * when a task counts as overdue or due soon. The follow-ups service never decides on its own.
 *
 *   OPEN <──> IN_PROGRESS ──> DONE ──> OPEN (reopen)
 *     │            │
 *     └────────────┴──> CANCELLED ──> OPEN (reopen)
 *
 * OPEN and IN_PROGRESS are the "open" statuses: only they are listed as work to do, can become overdue and are
 * touched by the sweep. DONE needs no note; CANCELLED needs a reason (the database also checks it).
 */

export const FOLLOW_UP_STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export type FollowUpStatusValue = (typeof FOLLOW_UP_STATUSES)[number];

export const OPEN_FOLLOW_UP_STATUSES: readonly FollowUpStatusValue[] = ["OPEN", "IN_PROGRESS"];

export const FOLLOW_UP_TRANSITIONS: Readonly<Record<FollowUpStatusValue, readonly FollowUpStatusValue[]>> = {
  OPEN: ["IN_PROGRESS", "DONE", "CANCELLED"],
  IN_PROGRESS: ["OPEN", "DONE", "CANCELLED"],
  DONE: ["OPEN"],
  CANCELLED: ["OPEN"],
};

export const isFollowUpStatus = (value: string): value is FollowUpStatusValue =>
  (FOLLOW_UP_STATUSES as readonly string[]).includes(value);

export const isOpenFollowUpStatus = (status: FollowUpStatusValue): boolean => OPEN_FOLLOW_UP_STATUSES.includes(status);

export function canTransitionFollowUp(from: FollowUpStatusValue, to: FollowUpStatusValue): boolean {
  return FOLLOW_UP_TRANSITIONS[from].includes(to);
}

/** Statuses a task can be moved to from `from` (what a client may offer as actions). */
export function nextFollowUpStatuses(from: FollowUpStatusValue): readonly FollowUpStatusValue[] {
  return FOLLOW_UP_TRANSITIONS[from];
}

/** An open task whose due time has passed. A task due exactly now is not overdue yet. */
export function isFollowUpOverdue(status: FollowUpStatusValue, dueAt: Date, now: Date): boolean {
  return isOpenFollowUpStatus(status) && dueAt.getTime() < now.getTime();
}

/** An open task that is not overdue but falls due within `dueSoonMinutes` from now (the tenant's setting). */
export function isFollowUpDueSoon(status: FollowUpStatusValue, dueAt: Date, now: Date, dueSoonMinutes: number): boolean {
  return (
    isOpenFollowUpStatus(status) &&
    dueAt.getTime() >= now.getTime() &&
    dueAt.getTime() <= now.getTime() + dueSoonMinutes * 60_000
  );
}
