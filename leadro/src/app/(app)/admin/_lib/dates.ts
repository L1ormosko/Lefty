/**
 * `<input type="date">` gives `YYYY-MM-DD`; the services want ISO instants with an offset.
 * An END date means "through that day", so it becomes the last second of the day (UTC). Returns
 * undefined for a blank or malformed value, leaving the service's own validation to report it.
 */
export function endOfDayInstant(date: string | undefined): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? `${date}T23:59:59Z` : undefined;
}

/** A START date means "from the beginning of that day" (UTC). */
export function startOfDayInstant(date: string | undefined): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? `${date}T00:00:00Z` : undefined;
}
