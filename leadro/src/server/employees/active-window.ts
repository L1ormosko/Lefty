/** The row's end, but never at or before its start (the DB requires `effectiveTo > effectiveFrom`). */
export function endInstant(effectiveFrom: Date, wanted: Date): Date {
  return wanted > effectiveFrom ? wanted : new Date(effectiveFrom.getTime() + 1);
}
