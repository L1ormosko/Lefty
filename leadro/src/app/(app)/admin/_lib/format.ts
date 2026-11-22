import { SUPPORTED_LOCALES, formatDate, formatDateTime, type Locale, type TranslateFn } from "@/lib/i18n";
import type { StatusTone } from "@/components/ui";

const LOCALE_LABEL_KEYS = { "en-US": "LOCALE.EN_US", "es-US": "LOCALE.ES_US", "he-IL": "LOCALE.HE_IL" } as const;

/** `{ value, label }` options for a language select, labelled in the viewer's language. */
export function localeOptions(t: TranslateFn): Array<{ value: string; label: string }> {
  return SUPPORTED_LOCALES.map((value) => ({ value, label: t(LOCALE_LABEL_KEYS[value]) }));
}

/** Display name of a locale code stored in the database; unknown codes are shown as stored. */
export function localeLabel(t: TranslateFn, value: unknown): string {
  return typeof value === "string" && value in LOCALE_LABEL_KEYS ? t(LOCALE_LABEL_KEYS[value as Locale]) : String(value ?? "");
}

/** The viewer's locale and zone, bundled for the date helpers below. */
export interface ViewerFormat {
  locale: Locale;
  timeZone: string;
}

/** Instant (Date or ISO string from a service) as a locale date + time, or an em dash when absent. */
export function showDateTime(value: unknown, viewer: ViewerFormat): string {
  if (!value) return "—";
  return formatDateTime(value as Date | string, viewer);
}

/** Calendar date only. Dates stored as `date` columns are UTC midnight, so they are shown in UTC. */
export function showDate(value: unknown, viewer: ViewerFormat): string {
  if (!value) return "—";
  return formatDate(value as Date | string, { locale: viewer.locale, timeZone: "UTC" });
}

/** "First Last" from partial (possibly field-limited) employee data; empty when the names are hidden. */
export function fullNameOf(person: { firstName?: unknown; lastName?: unknown }): string {
  return [person.firstName, person.lastName].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}

/** Tone of a lifecycle status for `StatusBadge` (never colour alone: the badge also shows the text). */
export function toneOfStatus(status: string): StatusTone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "ON_LEAVE":
    case "INVITED":
    case "SCHEDULED":
      return "warning";
    case "TERMINATED":
    case "DEACTIVATED":
    case "LOCKED":
    case "REVOKED":
      return "danger";
    default:
      return "neutral";
  }
}

/** All IANA zones the runtime knows, for a `<datalist>`. */
export function knownTimeZones(): string[] {
  return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
}

/** Next.js passes `searchParams` as a promise of this shape. */
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
