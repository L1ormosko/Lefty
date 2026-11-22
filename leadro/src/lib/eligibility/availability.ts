import {
  addDays,
  firstInstantAtOrAfterWall,
  isoDayOfWeek,
  localIsoDate,
  wallMsOf,
} from "../zoned-time";
import type { AvailabilityFact } from "./types";

/** A half-open span of instants `[start, end)` in epoch milliseconds. */
export interface Span {
  start: number;
  end: number;
}

export type AvailabilityVerdict =
  | { available: true }
  | { available: false; reason: "TIME_OFF"; blockedBy: Span }
  | { available: false; reason: "OUTSIDE_HOURS" };

const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The concrete spans a recurring weekly window occupies within `[window.start, window.end]`.
 * The window is read on each LOCAL calendar date in its own zone, so a 09:00-17:00 window is
 * 14:00-22:00 UTC in New York in winter and 13:00-21:00 in summer. A window that does not cross
 * midnight (schema CHECK) touches only the dates between the local dates of the two ends.
 *
 * Daylight saving: a window covers the instants whose local clock lies in `[startMinute, endMinute)`.
 * A boundary on a skipped wall time (02:30 on spring-forward day) lands where the clocks jump; one
 * on a repeated wall time lands on its first occurrence (see `firstInstantAtOrAfterWall`).
 */
function weeklyWindowSpans(fact: AvailabilityFact, window: Span): Span[] {
  if (fact.isoDayOfWeek === null || fact.startMinute === null || fact.endMinute === null) return [];
  const firstDate = localIsoDate(window.start, fact.timeZone);
  const lastDate = localIsoDate(window.end, fact.timeZone);
  const validFrom = fact.validFrom ? toDateString(fact.validFrom) : null;
  const validTo = fact.validTo ? toDateString(fact.validTo) : null;

  const spans: Span[] = [];
  for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
    if (isoDayOfWeek(date) !== fact.isoDayOfWeek) continue;
    if ((validFrom && date < validFrom) || (validTo && date > validTo)) continue;
    spans.push({
      start: firstInstantAtOrAfterWall(wallMsOf(date, fact.startMinute), fact.timeZone),
      end: firstInstantAtOrAfterWall(wallMsOf(date, fact.endMinute), fact.timeZone),
    });
  }
  return spans;
}

/** Sorts and merges touching or overlapping spans. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].filter((span) => span.end > span.start).sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * May the employee work the WHOLE of `window`?
 *  1. An EXCEPTION_UNAVAILABLE (time off, sick leave) overlapping the window blocks it, whatever the
 *     weekly schedule says ("exceptions beat weekly windows").
 *  2. Otherwise every instant of the window must lie inside a weekly window or an EXCEPTION_AVAILABLE
 *     span (extra shifts). Windows are merged first, so a split shift 08-12 + 12-16 covers 10-14 and
 *     an overnight shift modelled as two windows (Mon 22-24, Tue 00-06) covers 23:00-01:00.
 * An employee with no availability rows at all is therefore never available: "no schedule recorded"
 * must not read as "free all week".
 */
export function checkAvailability(facts: AvailabilityFact[], window: Span): AvailabilityVerdict {
  const blocked = facts
    .filter((fact) => fact.kind === "EXCEPTION_UNAVAILABLE" && fact.startsAt && fact.endsAt)
    .map((fact) => ({ start: (fact.startsAt as Date).getTime(), end: (fact.endsAt as Date).getTime() }))
    .find((span) => span.start < window.end && span.end > window.start);
  if (blocked) return { available: false, reason: "TIME_OFF", blockedBy: blocked };

  const open: Span[] = [];
  for (const fact of facts) {
    if (fact.kind === "WEEKLY_WINDOW") open.push(...weeklyWindowSpans(fact, window));
    else if (fact.kind === "EXCEPTION_AVAILABLE" && fact.startsAt && fact.endsAt) {
      open.push({ start: fact.startsAt.getTime(), end: fact.endsAt.getTime() });
    }
  }
  const covered = mergeSpans(open).some((span) => span.start <= window.start && span.end >= window.end);
  return covered ? { available: true } : { available: false, reason: "OUTSIDE_HOURS" };
}
