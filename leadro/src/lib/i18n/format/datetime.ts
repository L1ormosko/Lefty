import type { Locale } from "../locales";

export interface DateTimeFormatOptions {
  locale: Locale;
  /**
   * IANA zone of the business context (see `resolveTimeZone`). Required on purpose: timestamps are
   * stored UTC and employees work in different zones (§16.5), so the caller must choose; falling
   * back to the server's zone would silently show wrong times.
   */
  timeZone: string;
}

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date value: ${String(value)}`);
  return date;
}

/** "Nov 21, 2026" style date in the given zone (the calendar day can differ between zones). */
export function formatDate(value: DateInput, { locale, timeZone }: DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(toDate(value));
}

/** "3:05 PM" style time in the given zone. */
export function formatTime(value: DateInput, { locale, timeZone }: DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(toDate(value));
}

/** Date plus time in the given zone (no zone label; use `formatDateTimeWithZone` when it matters). */
export function formatDateTime(value: DateInput, { locale, timeZone }: DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(toDate(value));
}

/** Like `formatDateTime` but appends the zone abbreviation (e.g. "EST", "GMT+2"). */
export function formatDateTimeWithZone(value: DateInput, { locale, timeZone }: DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, {
    // dateStyle/timeStyle cannot be combined with timeZoneName, so spell the fields out.
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(toDate(value));
}
