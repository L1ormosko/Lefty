/**
 * Closing instant for a time-bounded grant (territory, job permission): now, but always after the
 * row started, because the schema requires `effectiveTo > effectiveFrom`. Ending a row that has not
 * started yet therefore cancels it one millisecond after its start.
 */
export const endInstant = (effectiveFrom: Date, now: Date): Date => new Date(Math.max(now.getTime(), effectiveFrom.getTime() + 1));
