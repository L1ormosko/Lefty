/**
 * Time-zone arithmetic on top of `Intl`, for availability windows and credential expiry (§16.5, §10.1).
 * Pure: no Prisma, no Next. All instants are epoch milliseconds in UTC.
 *
 * The vocabulary: a "wall time" is a local clock reading in an IANA zone. We represent one as the
 * epoch milliseconds the same reading would have in UTC (`wallMs`), which makes minute arithmetic on
 * a calendar date trivial. Daylight-saving transitions mean a wall time can be skipped (spring
 * forward) or happen twice (fall back); the helpers below define what happens in both cases.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The local clock reading in `zone` at `instantMs`, as UTC milliseconds ("wall ms"). Second precision. */
export function wallMsAt(instantMs: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** Offset of `zone` from UTC at `instantMs` (positive east of Greenwich). */
function offsetMsAt(instantMs: number, zone: string): number {
  return wallMsAt(instantMs, zone) - Math.floor(instantMs / SECOND_MS) * SECOND_MS;
}

/** `YYYY-MM-DD` of a wall time. */
export function isoDateOfWall(wallMs: number): string {
  return new Date(wallMs).toISOString().slice(0, 10);
}

/** Wall time for `isoDate` (`YYYY-MM-DD`) at `minuteOfDay` minutes after local midnight; 1440 = next midnight. */
export function wallMsOf(isoDate: string, minuteOfDay: number): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`) + minuteOfDay * MINUTE_MS;
}

/** The calendar date `days` after `isoDate` (negative = before). */
export function addDays(isoDate: string, days: number): string {
  return isoDateOfWall(Date.parse(`${isoDate}T00:00:00.000Z`) + days * DAY_MS);
}

/** ISO day of week of a calendar date: 1 = Monday .. 7 = Sunday. */
export function isoDayOfWeek(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The local calendar date in `zone` at `instantMs`. */
export function localIsoDate(instantMs: number, zone: string): string {
  return isoDateOfWall(wallMsAt(instantMs, zone));
}

/**
 * The first instant whose local clock reads `wallMs` or later.
 *  - an ordinary wall time maps to its instant;
 *  - one that happens TWICE (clocks go back) maps to the first occurrence;
 *  - one that does not exist (clocks go forward, e.g. 02:30) maps to the moment the clocks jump,
 *    i.e. the first instant after the skipped hour.
 * So "starts at 02:30" never begins before the wall time it names, and "ends at 02:30" ends when
 * the clocks jump.
 */
export function firstInstantAtOrAfterWall(wallMs: number, zone: string): number {
  const offsetBefore = offsetMsAt(wallMs - DAY_MS, zone);
  const offsetAfter = offsetMsAt(wallMs + DAY_MS, zone);
  const candidates = [wallMs - offsetBefore, wallMs - offsetAfter];
  const exact = candidates.filter((candidate) => wallMsAt(candidate, zone) === wallMs);
  if (exact.length > 0) return Math.min(...exact);

  // Skipped wall time: the answer is the transition instant. Within [low, high] the local clock only
  // moves forward, so a binary search on "clock reading >= wallMs" is valid.
  let low = Math.min(...candidates);
  let high = Math.max(...candidates);
  while (high - low > SECOND_MS) {
    const middle = low + Math.floor((high - low) / 2 / SECOND_MS) * SECOND_MS;
    if (middle === low) break;
    if (wallMsAt(middle, zone) >= wallMs) high = middle;
    else low = middle;
  }
  return high;
}

/** Instant a local calendar day starts in `zone` (00:00, or the first valid instant after it). */
export function startOfLocalDay(isoDate: string, zone: string): number {
  return firstInstantAtOrAfterWall(wallMsOf(isoDate, 0), zone);
}

/** First instant AFTER the local calendar day `isoDate` in `zone` (the start of the next day). */
export function endOfLocalDay(isoDate: string, zone: string): number {
  return startOfLocalDay(addDays(isoDate, 1), zone);
}
