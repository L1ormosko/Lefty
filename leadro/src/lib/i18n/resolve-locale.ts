import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from "./locales";

/** Candidate settings at each level; any may be null/undefined/unsupported and is then skipped. */
export interface LocaleSources {
  /** Individual user preference (overrides the company default for the UI, §16.2). */
  user?: string | null;
  /** Branch (org unit) default. */
  branch?: string | null;
  /** Company (tenant) default. */
  company?: string | null;
}

/**
 * Ordered, de-duplicated fallback chain: user → branch → company → en-US (§16.2).
 * Unsupported values (e.g. a locale removed later) are dropped instead of breaking the UI.
 */
export function buildLocaleChain(sources: LocaleSources): Locale[] {
  const candidates = [sources.user, sources.branch, sources.company, DEFAULT_LOCALE];
  const chain: Locale[] = [];
  for (const candidate of candidates) {
    if (isSupportedLocale(candidate) && !chain.includes(candidate)) chain.push(candidate);
  }
  return chain;
}

/** The locale the interface is displayed in: first entry of the chain. */
export function resolveUiLocale(sources: LocaleSources): Locale {
  return buildLocaleChain(sources)[0];
}

/**
 * Locale for communication sent TO a customer: the customer's own preference first (§6.1), then
 * the branch and company defaults. The staff member's personal UI language is deliberately not
 * consulted, because it says nothing about what the customer reads.
 */
export function resolveCustomerCommunicationLocale(sources: {
  customer?: string | null;
  branch?: string | null;
  company?: string | null;
}): Locale {
  return resolveUiLocale({ user: sources.customer, branch: sources.branch, company: sources.company });
}

/** True if the runtime's Intl database knows the IANA zone name. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Time zone for displaying a timestamp "in business context" (§16.5): the user's own zone, else
 * the branch's, else the company's. Timestamps are stored UTC; employees may work in different
 * zones, so there is intentionally no global default beyond the company's.
 */
export function resolveTimeZone(sources: {
  user?: string | null;
  branch?: string | null;
  company: string;
}): string {
  const candidates = [sources.user, sources.branch, sources.company];
  const valid = candidates.find((zone): zone is string => typeof zone === "string" && isValidTimeZone(zone));
  return valid ?? sources.company;
}
